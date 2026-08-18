/**
 * 笔记协作文档（Yjs）生命周期与每文件单例注册表。
 *
 * 每篇打开/编辑的笔记持一个独立 `Y.Doc`（根键 "text" = `Y.Text` 全文 Markdown）。
 * - 打开/进入编辑：以磁盘正文初始化 `Y.Doc`（快照基线，仅当无激活编辑器时重置）。
 * - 编辑：`y-codemirror.next` 绑定 `Y.Text`；远端 update 经 `receiveSyncMessage` 合入。
 * - 落盘：收敛后全文（`flushNoteDoc`）写回 `.md` 真源（调用方负责）。
 * - awareness：本地光标/选中/身份经 `y-codemirror.next` 更新；远端状态用于渲染用户色光标/选中。
 *
 * 多面积打开同一笔记共享同一 `Y.Doc` 实例（per-file 单例引用计数），避免多 doc 分叉。
 * 本模块为纯数据/同步层：网络收发经 collabStore 注入的广播钩子完成，不直连 relay。
 *
 * 同步协议（y-protocols sync，经 JSON base64 传输）：
 * - 加入房间广播 `syncStep1`（状态向量）；对端收到回 `syncStep2`（全量状态）。
 * - 之后本地编辑产生的增量 update 直接广播；对端 `syncStep2`/`update` 合入（origin=远端，
 *   不回发——本端已知该状态，防回环）。
 */
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  messageYjsSyncStep1,
  readSyncMessage,
  writeSyncStep1,
} from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/** 远端合入 origin 标记：本端 applyUpdate 用它，doc 'update' 事件据此对应用跳过回发。 */
const REMOTE_ORIGIN = "note-collab-remote";

/** 本端 awareness（光标/选中）广播节流：高频合并，防止每次选区变化刷屏 relay。 */
const AWARE_THROTTLE_MS = 100;

/**
 * 确定性磁盘基线 seed 客户端 id：所有对端以同一 clientID 重建磁盘基线 → 合并幂等不重复。
 * 若各对端各自用随机 clientID 插入同一正文，合并时两条 struct 并存 → 内容翻倍、
 * 相对位置错乱（光标互见失效）、本端落盘与对端相悖（误报外部覆盖）。
 */
const BASELINE_SEED_CLIENT_ID = 1;

/**
 * 以固定 seed 客户端把磁盘正文编码成一个确定的 Yjs update：
 * 各对端对同一正文生成字节相同的基线 struct，`applyUpdate` 合并幂等，无重复。
 */
function baselineSeedUpdate(text: string): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = BASELINE_SEED_CLIENT_ID;
  seed.getText("text").insert(0, text);
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return update;
}

export interface NoteDoc {
  /** 仓库相对路径。 */
  file: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
}

/** 网络广播钩子（由 collabStore 注入；未启用协作时为 null）。 */
export interface NoteCollabBroadcast {
  /** 广播 Yjs 同步消息（syncStep1/2 或增量 update，已按 y-protocols 协议编码）。 */
  sendSyncMessage: (file: string, payload: Uint8Array) => void;
  /** 广播 awareness 更新（y-protocols 编码）。 */
  sendAwareness: (file: string, payload: Uint8Array) => void;
}

let broadcast: NoteCollabBroadcast | null = null;

/** collabStore 注入/解除网络广播钩子（协作开关切换时调用）。 */
export function setNoteCollabBroadcast(b: NoteCollabBroadcast | null): void {
  broadcast = b;
}

/** 每文件单例注册表（Y.Doc 生命周期）。 */
interface Entry {
  doc: NoteDoc;
  viewCount: number;
}

const entries = new Map<string, Entry>();

/** 为本地文档绑定 awareness 身份（昵称/用户色；collabStore 打开协作笔记时调用，可幂等重设）。 */
export function setNoteCollabIdentity(file: string, user: { name: string; color: string }): void {
  const e = entries.get(file);
  if (!e) return;
  e.doc.awareness.setLocalStateField("user", {
    name: user.name,
    color: user.color,
    colorLight: `${user.color}33`,
  });
}

function createDoc(file: string, text: string): NoteDoc {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("text");
  // 以确定性 seed 客户端重建磁盘基线（而非本端随机 clientID 直接 insert）——
  // 保证所有对端基线 struct 一致，合并不重复（见 baselineSeedUpdate 注释）。
  Y.applyUpdate(ydoc, baselineSeedUpdate(text));
  const awareness = new Awareness(ydoc);

  // 本端增量 update 广播：远端合入（origin=REMOTE_ORIGIN）不回发，防回环；本地编辑/初始状态均发
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    if (broadcast) {
      broadcast.sendSyncMessage(file, writeUpdateHeader(update));
    }
  });

  // 本端 awareness（光标/选中/身份）变更 → 节流编码广播（光标/选中高频变化合并，防刷屏 relay）；
  // 远端应用（origin=remote）不再回发
  let awarePending: { payload: Uint8Array } | null = null;
  let awareTimer: number | null = null;
  awareness.on(
    "update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === "remote") return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0 || !broadcast) return;
      awarePending = { payload: encodeAwarenessUpdate(awareness, changed) };
      if (awareTimer !== null) return;
      awareTimer = window.setTimeout(() => {
        awareTimer = null;
        if (awarePending && broadcast) {
          broadcast.sendAwareness(file, awarePending.payload);
        }
        awarePending = null;
      }, AWARE_THROTTLE_MS);
    },
  );

  const doc: NoteDoc = {
    file,
    ydoc,
    ytext,
    awareness,
  };
  return doc;
}

/** y-protocols sync 的 `update` 消息编码 = 消息类型头 + update bytes。 */
function writeUpdateHeader(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 2); // messageYjsUpdate
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/**
 * 打开并绑定笔记文档：有激活编辑器（多面积共享）时复用现有 doc；
 * 无激活时以磁盘正文 text 重置基线（快照）后返回。调用方应在编辑器挂载时调用（refCount++）。
 * 传入的 text 为 LF 规范化后的全文（调用方保证）。
 */
export function bindNoteDoc(file: string, text: string): NoteDoc {
  const existing = entries.get(file);
  if (existing && existing.viewCount > 0) {
    existing.viewCount += 1;
    return existing.doc;
  }
  // 无激活编辑器：销毁旧 doc（其内部观察者随之释放），以磁盘基线重建
  existing?.doc.ydoc.destroy();
  entries.delete(file);
  const doc = createDoc(file, text);
  entries.set(file, { doc, viewCount: 1 });
  // 新 doc 首帧本地状态：广播 syncStep1（加入房间握手，索取对端全量状态）
  const encoder = encoding.createEncoder();
  writeSyncStep1(encoder, doc.ydoc);
  broadcast?.sendSyncMessage(file, encoding.toUint8Array(encoder));
  return doc;
}

/** 编辑器卸载时释放（refCount--）；归零仍在注册表（内存开销小，保留远端状态），下次打开重置基线。 */
export function unbindNoteDoc(file: string): void {
  const e = entries.get(file);
  if (!e) return;
  e.viewCount = Math.max(0, e.viewCount - 1);
}

/**
 * 合入远端 sync 消息（y-protocols 编码：step1/step2/update）。
 * step1 要求回复 step2（全量状态）——编码输出广播给房间（幂等收敛，对端请求者应用）。
 */
export function receiveSyncMessage(file: string, payload: Uint8Array): void {
  const e = entries.get(file);
  if (!e) return;
  const decoder = decoding.createDecoder(payload);
  const encoder = encoding.createEncoder();
  let replyNeeded = false;
  try {
    const type = readSyncMessage(decoder, encoder, e.doc.ydoc, REMOTE_ORIGIN, (err) => {
      console.error("笔记协作同步合入失败", err);
    });
    replyNeeded = type === messageYjsSyncStep1;
  } catch {
    // 解析失败的消息（乱序/格式异常）：丢弃，下一帧握手兜底收敛
    return;
  }
  if (replyNeeded && broadcast) {
    broadcast.sendSyncMessage(file, encoding.toUint8Array(encoder));
  }
}

/** 合入远端 awareness 更新（只应用不回发，防回环；y-remote-selections 监听 change 重绘）。 */
export function receiveAwareness(file: string, payload: Uint8Array): void {
  const e = entries.get(file);
  if (!e) return;
  applyAwarenessUpdate(e.doc.awareness, payload, "remote");
}

/** 全部销毁（应用退出/切仓库清空协作上下文）。 */
export function destroyAllNoteDocs(): void {
  for (const e of entries.values()) {
    e.doc.ydoc.destroy();
  }
  entries.clear();
}

/** 重连后对所有激活协作文档重发 syncStep1（重新握手，索取对端全量状态收敛）。 */
export function resyncAllNoteDocs(): void {
  if (!broadcast) return;
  for (const e of entries.values()) {
    if (e.viewCount <= 0) continue;
    const encoder = encoding.createEncoder();
    writeSyncStep1(encoder, e.doc.ydoc);
    broadcast.sendSyncMessage(e.doc.file, encoding.toUint8Array(encoder));
  }
}
