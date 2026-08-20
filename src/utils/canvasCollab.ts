/**
 * 画布多人实时协作纯函数：引用 diff / 纯序列化 / 消息合并 / 锁主判定。
 *
 * 与磁盘保存同源但不带副作用——`diffCanvasEntities` 被 `patchCanvasVault`（磁盘）与协作广播
 * （relay `canvas-patch`）共用；`serializeNodeForCollab` 是 `toFileNode` 的纯版本（**不触发
 * `.md` 写入**——协作广播绝不能因广播而写文件）。接收端经 `deserializeNodeForCollab` 反解回
 * 运行时形态（conversation 的 `data.messages` 拆回 `messagesByConv` 并剥离）。
 *
 * 本模块全部为纯函数，无 I/O、无 store 依赖，便于单测。
 */
import type { Node } from "@xyflow/react";
import type {
  CanvasEdge,
  CanvasFileEdge,
  CanvasFileNode,
  CanvasPatch,
  Message,
} from "@/types";

/** 增量 diff 基线（与 canvasStore 落盘/广播快照同构；未变实体引用相同即视为未变化）。 */
export interface CanvasDiffBaseline {
  nodes: Node[];
  edges: CanvasEdge[];
  messagesByConv: Record<string, Message[]>;
}

/** 引用 diff 结果：只含变化/新增/删除的实体 id。 */
export interface CanvasDiffResult {
  upsertNodeIds: Set<string>;
  removedNodeIds: string[];
  upsertEdgeIds: Set<string>;
  removedEdgeIds: string[];
}

/**
 * 引用 diff（store 不可变更新，未变实体引用相同，O(N) 指针比对）：
 * - 节点：引用不同 = 变化/新增；对话节点消息数组引用变化（`messagesByConv` 与节点分离）也计入。
 * - 边：引用不同 = 变化/新增。
 * 与 `patchCanvasVault` 的磁盘 diff 完全同源（自动保存主路径），协作广播复用同一函数。
 */
export function diffCanvasEntities(
  nodes: Node[],
  edges: CanvasEdge[],
  messagesByConv: Record<string, Message[]>,
  lastSaved: CanvasDiffBaseline,
): CanvasDiffResult {
  // 预建 id → 实体索引替代循环内 .find()（大画布 O(N²) → O(N)；每次自动保存/广播都会跑）
  const lastNodesById = new Map(lastSaved.nodes.map((n) => [n.id, n]));
  const lastEdgesById = new Map(lastSaved.edges.map((e) => [e.id, e]));
  // 节点 diff：引用不同 = 变化/新增；对话节点消息变化时节点引用不变，按 conv id 补进 upsert
  const upsertNodeIds = new Set<string>();
  for (const n of nodes) {
    const ls = lastNodesById.get(n.id);
    if (!ls || ls !== n) upsertNodeIds.add(n.id);
  }
  for (const [convId, msgs] of Object.entries(messagesByConv)) {
    if (lastSaved.messagesByConv[convId] !== msgs) upsertNodeIds.add(convId);
  }
  const currentNodeIds = new Set(nodes.map((n) => n.id));
  const removedNodeIds = lastSaved.nodes
    .filter((n) => !currentNodeIds.has(n.id))
    .map((n) => n.id);
  const upsertEdgeIds = new Set<string>();
  for (const e of edges) {
    const ls = lastEdgesById.get(e.id);
    if (!ls || ls !== e) upsertEdgeIds.add(e.id);
  }
  const currentEdgeIds = new Set(edges.map((e) => e.id));
  const removedEdgeIds = lastSaved.edges
    .filter((e) => !currentEdgeIds.has(e.id))
    .map((e) => e.id);
  return { upsertNodeIds, removedNodeIds, upsertEdgeIds, removedEdgeIds };
}

/** 运行时边 → 协作补丁边（与 `toFileEdge` 同构；createdAt 接收端不关心，传 0）。 */
function serializeEdgeForCollab(e: CanvasEdge): CanvasFileEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    directed: e.directed,
    linkMode: e.linkMode,
    createdAt: 0,
  };
}

/**
 * 运行时节点 → 协作补丁节点（`toFileNode` 的纯版本，无 `.md` 写副作用）：
 * - text 有 file = 笔记节点：正文在共享盘 `.md`（对端靠 watcher 同步），只携带结构 `{title, file}`
 * - text 无 file = 画布内文本节点：`bodyMd` 随补丁内嵌携带
 * - conversation：嵌入 `messagesByConv[id]` 到 `data.messages`（接收端反解）
 * - group/link/table：与磁盘序列化一致（table 快照在 `.atb`，接收端自行补读）
 * - media/search：原样保留
 */
export function serializeNodeForCollab(
  n: Node,
  messagesByConv: Record<string, Message[]>,
): CanvasFileNode {
  let data: Record<string, unknown>;
  if (n.type === "text") {
    const td = n.data as unknown as { title?: string; file?: string; bodyMd?: string };
    if (td.file) {
      data = { title: td.title || "未命名", file: td.file };
    } else {
      data = { title: td.title || "未命名", bodyMd: td.bodyMd ?? "" };
    }
  } else if (n.type === "conversation") {
    data = { ...n.data, messages: messagesByConv[n.id] ?? [] };
  } else if (n.type === "group") {
    const gd = n.data as unknown as { label?: string; color?: string };
    data = { label: gd.label ?? "分组", color: gd.color };
  } else if (n.type === "link") {
    data = { url: (n.data as unknown as { url?: string }).url ?? "" };
  } else if (n.type === "table") {
    const td = n.data as unknown as { title?: string; file?: string };
    data = { title: td.title || "未命名", file: td.file };
  } else {
    // media/search：原样保留（media 的 thumb/body 已随运行时 data 携带）
    data = { ...n.data };
  }
  return {
    id: n.id,
    type: n.type as CanvasFileNode["type"],
    x: n.position.x,
    y: n.position.y,
    width: n.width,
    height: n.height,
    data: data as unknown as CanvasFileNode["data"],
  };
}

/** 协作补丁节点反解结果（运行时形态）。 */
export interface DeserializedCollabNode {
  /** 运行时节点（position 展开；conversation data 已剥离 `messages`；group 补 zIndex -1）。 */
  node: Node;
  /** conversation 节点：提取出的消息数组（接收端按 id 合并进 `messagesByConv`）。 */
  messages?: Message[];
  /** text 节点（有 file）：接收端需补读正文（bodyMd 不在补丁内，在共享盘 `.md`）。 */
  refreshBodyMdFile?: string;
}

/**
 * 协作补丁节点 → 运行时节点（`canvasFileToRuntime` 的协作版，同步处理逻辑一致）：
 * - conversation：`data.messages` 提取并剥离 → `messages`
 * - text 有 file：标记 `refreshBodyMdFile`（对端从共享盘 `.md` 补读正文）
 * - group：运行时补 `zIndex: -1`（低层背景容器，与 load 路径一致，防协作新增分组盖到节点上）
 */
export function deserializeNodeForCollab(fileNode: CanvasFileNode): DeserializedCollabNode {
  const data: Record<string, unknown> = { ...fileNode.data };
  let messages: Message[] | undefined;
  let refreshBodyMdFile: string | undefined;
  if (fileNode.type === "conversation") {
    const cd = data as unknown as { messages?: Message[] };
    messages = cd.messages ?? [];
    delete data.messages;
  } else if (fileNode.type === "text") {
    const td = data as unknown as { file?: string };
    if (td.file) refreshBodyMdFile = td.file;
  }
  const node: Node = {
    id: fileNode.id,
    type: fileNode.type,
    position: { x: fileNode.x, y: fileNode.y },
    width: fileNode.width,
    height: fileNode.height,
    data: data as Node["data"],
  };
  if (fileNode.type === "group") node.zIndex = -1;
  return { node, messages, refreshBodyMdFile };
}

/**
 * 按 id 合并对话消息：远端为基底，本地独有消息（对端尚未见到的进行中/流式消息）按原序补入。
 * 与 `mergeFromDisk` 的消息合并语义一致——锁模型下对端不会并发写消息，此合并仅兜底保护
 * 本端进行中内容不被对端陈旧节点快照覆盖（如对端移动本端正在生成的节点）。
 */
export function mergeMessages(remote: Message[], local: Message[]): Message[] {
  if (local.length === 0) return remote;
  if (remote.length === 0) return local;
  const remoteIds = new Set(remote.map((m) => m.id));
  const extras = local.filter((m) => !remoteIds.has(m.id));
  return extras.length === 0 ? remote : [...remote, ...extras];
}

/** 计算协作广播补丁（diff + 纯序列化）；无变化返回 null（调用方跳过广播）。 */
export function computeCanvasCollabPatch(opts: {
  canvasId: string;
  title: string;
  nodes: Node[];
  edges: CanvasEdge[];
  messagesByConv: Record<string, Message[]>;
  lastSaved: CanvasDiffBaseline & { title: string };
}): CanvasPatch | null {
  const { canvasId, title, nodes, edges, messagesByConv, lastSaved } = opts;
  const { upsertNodeIds, removedNodeIds, upsertEdgeIds, removedEdgeIds } = diffCanvasEntities(
    nodes,
    edges,
    messagesByConv,
    lastSaved,
  );
  const upsertNodes: CanvasFileNode[] = [];
  for (const n of nodes) {
    if (!upsertNodeIds.has(n.id)) continue;
    upsertNodes.push(serializeNodeForCollab(n, messagesByConv));
  }
  const upsertEdges: CanvasFileEdge[] = edges
    .filter((e) => upsertEdgeIds.has(e.id))
    .map(serializeEdgeForCollab);
  const titleChanged = title !== lastSaved.title;
  if (
    upsertNodes.length === 0 &&
    upsertEdges.length === 0 &&
    removedNodeIds.length === 0 &&
    removedEdgeIds.length === 0 &&
    !titleChanged
  ) {
    return null;
  }
  return {
    id: canvasId,
    upsertNodes,
    removedNodeIds,
    upsertEdges,
    removedEdgeIds,
    ...(titleChanged ? { title } : {}),
  };
}

/**
 * 确定性锁主判定：`since` 最小者持有；同 `since` 按 `peerId` 递增取小（relay 全局递增分配，
 * 各对端对同一批声明计算出一致锁主 → UI 确定性只读，不闪烁）。
 * 无声明返回 null。返回锁主 peerId。
 */
export function computeLockOwner(claims: { peerId: number; since: number }[]): number | null {
  if (claims.length === 0) return null;
  let owner = claims[0].peerId;
  let best = claims[0].since;
  for (let i = 1; i < claims.length; i++) {
    const c = claims[i];
    if (c.since < best || (c.since === best && c.peerId < owner)) {
      best = c.since;
      owner = c.peerId;
    }
  }
  return owner;
}

/** 协作画布重命名抑制窗口（ms）：对端收到远端 title 补丁已同步新路径，watcher 收到
 * 旧路径 delete / 新路径 create 事件时在窗口内跳过 reload/conflict（内容已由补丁应用，
 * 含本地脏编辑不丢，待下次保存走乐观锁自动合并收敛）。仿 utils/selfSave 的时间窗模式。 */
const COLLAB_RENAME_SUPPRESS_MS = 10_000;
const collabRenameAt = new Map<string, number>();

/** 登记协作重命名涉及的文件路径（旧 + 新），watcher 据此跳过（见 canvasStore.applyRemoteCanvasPatch）。 */
export function markCollabCanvasRename(paths: string[]): void {
  const now = Date.now();
  for (const [p, at] of collabRenameAt) {
    if (now - at >= COLLAB_RENAME_SUPPRESS_MS) collabRenameAt.delete(p);
  }
  for (const p of paths) collabRenameAt.set(p, now);
}

/** watcher 画布分支判断该路径事件是否为协作重命名的回波（窗口内 = 跳过 reload/conflict）。 */
export function isCollabCanvasRenamePath(path: string): boolean {
  return Date.now() - (collabRenameAt.get(path) ?? 0) < COLLAB_RENAME_SUPPRESS_MS;
}
