import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge as rfAddEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import {
  loadCanvasVault,
  loadWhiteboardVault,
  persistCanvasVault,
  readAttachmentDataUrl,
  readCanvasVault,
  readNote,
  renameCanvasVault,
  importAttachmentVault,
} from "@/services/vault";
import { readTableVault } from "@/services/table";
import { tableToSnapshotText } from "@/utils/table";
import { toApiMessages, type ChatParams } from "@/services/ai/client";
import { abortAutoTitle } from "@/services/ai/autoTitle";
import { runSearch, resultsToText } from "@/services/search";
import { pickFile } from "@/services/dialog";
import { findFreeSpot, pickEdgeHandles } from "@/utils/layout";
import { inferImageMime } from "@/utils/whiteboard";
import { DEFAULT_CONVERSATION_WIDTH, DEFAULT_CONVERSATION_HEIGHT, DEFAULT_TEXT_NODE_WIDTH, DEFAULT_TEXT_NODE_HEIGHT, DEFAULT_TABLE_NODE_WIDTH, DEFAULT_TABLE_NODE_HEIGHT } from "@/constants/canvas";
import { WEB_SEARCH_TOOL } from "@/constants/tools";
import { runStreamExchange, decideCleanup, runAutoNaming } from "./streaming";
import { isAssetConsumed } from "@/utils/consumed";
import { prefix, scanMentionHits } from "@/utils/text";
import { sanitizeFilename, siblingPath } from "@/utils/filename";
import { useSettingsStore } from "./settingsStore";
import { useAppStore } from "./appStore";
import type {
  Attachment,
  CanvasEdge,
  ConversationData,
  LinkMode,
  TableData,
  TextData,
  MediaData,
  Message,
  PendingAttachment,
  SearchResultData,
} from "@/types";

const MAX_UNDO = 50;

/** Undo/Redo 快照（含 messagesByConv，否则分支撤销时消息状态会撕裂） */
interface Snapshot {
  nodes: Node[];
  edges: Edge[];
  messagesByConv: Record<string, Message[]>;
}

/** getReferencedInputs 返回的待注入引用（含源节点 id、显示名、注入内容）。 */
interface ReferencedInput {
  nodeId: string;
  label: string;
  content: string;
}

/** @ 提及映射：输入框内可见的 @显示名 → 源节点 id（发送时就地替换为引用内容）。 */
export interface Mention {
  nodeId: string;
  text: string;
}

/**
 * 单个画布的运行时状态。
 * - 节点/边变更 debounce 500ms 落库
 * - messages 按对话节点分组，流式回复完成时 upsert
 * - Undo/Redo 栈深 50，覆盖增删节点/连线/移动
 */

interface CanvasState {
  canvasId: string | null;
  /** 当前画布磁盘路径（相对仓库根，画布任意文件夹存放；打开/保存按此路径）。 */
  canvasFile: string | null;
  canvasTitle: string;
  nodes: Node[];
  edges: CanvasEdge[];
  /** 只读查看（外部白板格式 .canvas）：不落盘、禁编辑/删除/重命名。 */
  readOnly: boolean;
  /** 更新关联边的箭头模式（无向/单向/双向，样式切换不入 undo 栈）。 */
  setEdgeLinkMode: (edgeId: string, linkMode: LinkMode) => void;
  /** messages 按 conversationId 分组 */
  messagesByConv: Record<string, Message[]>;
  /** 各对话节点是否正在流式回复 */
  streamingByConv: Record<string, boolean>;
  /** 拖线引用队列：conversationId → 待进输入框 @标签 的节点 id（不立即建边，发送时自动连线） */
  pendingMentionsByConv: Record<string, string[]>;
  /** 拖线且已在历史注入过 → 待确认队列：conversationId → 节点 id（弹「连接 / 再次注入」菜单） */
  pendingConfirmByConv: Record<string, string[]>;
  /** 全局错误提示（如未配置 AI provider） */
  error: string | null;
  loading: boolean;
  saving: boolean;
  /** 是否有未保存变更（watcher 判断能否安全自动重载的依据）。 */
  dirty: boolean;
  /** 本地未保存改动与外部修改/磁盘版本冲突（提示用户重载，不自动覆盖或丢弃）。 */
  conflictPending: boolean;
  /** 乐观并发基准：加载时的磁盘 updatedAt，保存时透传 Rust 检查。 */
  baseUpdatedAt: number;
  load: (id: string) => Promise<void>;
  /** 更新画布标题 */
  renameCanvas: (title: string) => Promise<void>;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: OnConnect;
  /** 节点开始拖拽时保存快照 */
  onNodeDragStart: () => void;
  /** 节点拖动结束：重算相连边的锚点（位置自适应）。 */
  onNodeDragStop: (event: unknown, node: Node) => void;
  /** 添加节点到画布。 */
  addNode: (node: Node) => void;
  /**
   * 从仓库 `.md` 文件建文本节点（文件面板拖拽）：读正文填 bodyMd，
   * file 引用该文件（不复制）。findFreeSpot 避让已有节点。
   */
  addTextNoteFromVault: (file: string, title: string, position: { x: number; y: number }, exact?: boolean) => Promise<void>;
  /**
   * 从仓库附件建媒体节点（文件面板拖拽）：图片读 dataURL 设 thumb，文本类读内容设 body，
   * 解析失败标 parseFailed。file 引用该文件（不复制）。
   */
  addMediaFromVault: (file: string, name: string, position: { x: number; y: number }, exact?: boolean) => Promise<void>;
  /**
   * 从仓库 `.atb` 表格建表格节点（文件面板拖拽）：读文件填快照 snapshot，
   * file 引用该文件（不复制）。findFreeSpot 避让已有节点。
   */
  addTableFromVault: (file: string, title: string, position: { x: number; y: number }, exact?: boolean) => Promise<void>;
  /** 导入系统文件到仓库（service 只经 store 出口）。返回相对路径。 */
  importAttachment: (src: string, name: string) => Promise<string>;
  /** 系统对话框选文件 → 导入仓库 → 画布中心建媒体节点。用户取消返回 false。 */
  pickAndImportAttachment: (position: { x: number; y: number }) => Promise<boolean>;
  /** 查找引用指定 `.md` 文件的文本节点 id（双击定位用，无则 null）。 */
  findTextNoteByFile: (file: string) => string | null;
  /** 添加边到画布。 */
  addEdge: (edge: Edge) => void;
  /** 拖线引用：不立即建边，进输入框 @标签 队列（发送时自动连线）。 */
  queueMention: (conversationId: string, nodeId: string) => void;
  /** 清空某对话的拖线引用队列（输入框消费后）。 */
  clearPendingMentions: (conversationId: string) => void;
  /** 拖线已注入节点的「再次注入」：走正常引用流程（输入框 @标签，发送时注入；边已存在不可断开）。 */
  confirmConnect: (conversationId: string, nodeId: string) => void;
  /** 清空某对话的待确认队列（菜单消费后）。 */
  clearPendingConfirm: (conversationId: string) => void;
  /** 属性面板选中的节点 id（单击节点设置、单击空白清空；跨面积共享，null = 未选中）。 */
  selectedNodeId: string | null;
  /** 设置属性面板选中节点（null = 清空选中）。 */
  selectNode: (nodeId: string | null) => void;
  /** 更新节点 data（模型切换等内容变更，自动落库）。 */
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Rust 侧改过当前画布磁盘 .atlx 后同步乐观锁基准（重命名笔记/附件/画布），防下次保存被误判「已被外部修改」。 */
  syncBaseUpdatedAt: () => Promise<void>;
  /** 发送消息到指定对话节点，可携带待发送附件。 */
  send: (conversationId: string, content: string, attachments?: PendingAttachment[], mentions?: Mention[]) => Promise<void>;
  /** 重新生成该对话的最后一条 AI 回复（重发最后一条 user 消息，不追加新消息）。 */
  regenerate: (conversationId: string) => Promise<void>;
  /**
   * 「回到此处」：截断该消息（含）之后的全部消息，在该处继续对话。
   * 入 undo 栈可撤销（恢复被截断的消息）；已是最末消息则 no-op。
   */
  rollbackTo: (conversationId: string, messageId: string) => void;
  /**
   * 从父对话分支创建新对话节点：复制 upToMessageId（含）之前的全部完整消息到子节点，
   * 连一条父→子的有向边（仅表分支血缘，不注入数据），单次 undo 事务，快照语义。
   */
  branchFrom: (conversationId: string, upToMessageId: string, position: { x: number; y: number }) => Promise<void>;
  /** 中止某对话节点的流式回复。 */
  abort: (conversationId: string) => void;
  /** 清除全局错误。 */
  clearError: () => void;
  /** 删除所有选中的节点及关联的边（Delete/Backspace 快捷键）。 */
  deleteSelected: () => void;
  /** 获取某对话节点入边引用的文本/搜索节点（send 时一次性固化注入）。 */
  getReferencedInputs: (conversationId: string) => ReferencedInput[];
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  undo: () => void;
  redo: () => void;
  /** 保存当前快照到 undo 栈（清空 redo 栈）。内部方法，外部也可调用。 */
  pushUndo: () => void;
  // ===== watcher：外部编辑实时同步 + 断链降级 =====
  /** 查找引用某附件路径的 media 节点 id（对称 findTextNoteByFile，watcher 定位用）。 */
  findMediaNoteByFile: (file: string) => string | null;
  /**
   * silent 刷新 text 节点正文（重读 `.md`，不 persist 避免回环）。
   * 读失败（文件被删/重命名）→ markFileMissing。无引用节点时 no-op。
   */
  refreshTextContent: (file: string) => Promise<void>;
  /**
   * silent 刷新 media 节点（图片重读 dataURL、文本类重读 body，不 persist）。
   * 读失败 → markFileMissing。
   */
  refreshMediaContent: (file: string) => Promise<void>;
  /**
   * silent 刷新 table 节点快照（重读 `.atb`，不 persist 避免回环）。
   * 读失败 → markFileMissing。无引用节点时 no-op。
   */
  refreshTableContent: (file: string) => Promise<void>;
  /** 标记某 file 引用缺失（删除/重命名事件用，不删节点保留位置与边）。 */
  markFileMissing: (file: string, kind: "text" | "media" | "table") => void;
  /** 重载当前画布（外部修改自动重载时调用，读磁盘最新内容）。 */
  reloadFromDisk: () => Promise<void>;
  /** 冲突合并：以磁盘最新为基底，保留本地新增节点/边/消息（重叠以磁盘为准），合并后落盘。 */
  mergeFromDisk: () => Promise<void>;
  /** 清空当前画布运行时状态（删除当前画布时调用：取消保存定时器 + 中止流 + 复位全部画布态）。 */
  resetCanvasState: () => void;
  /** 重新执行搜索结果节点的搜索（失败降级重试）。 */
  retrySearch: (nodeId: string, query: string) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 自写回放抑制（watcher）=====
// schedulePersist 写完成时记录时刻；watcher 收到 .atlx 事件时若在抑制窗口内则视为自我回放，
// 不弹「画布已被外部修改」误提示。.md/附件事件不抑制（刷新幂等，silent 更新不 persist）。
let lastSelfSaveAt = 0;
const SELF_SAVE_SUPPRESS_MS = 2000;

/** watcher 事件处理器判断当前 .atlx 事件是否为 app 自写的回放。 */
export function isSelfSaveEcho(): boolean {
  return Date.now() - lastSelfSaveAt < SELF_SAVE_SUPPRESS_MS;
}

/** 供其他 store（appStore/vaultStore）在「软件内写 .atlx」后标记自写，抑制 watcher 误报。 */
export function markSelfSave(): void {
  lastSelfSaveAt = Date.now();
}

/**
 * debounce 500ms 持久化画布到仓库（拓扑 + messages 整体写 .atlx，text 正文写 .md）。
 * 在 timer 回调里读最新 state，确保流式完成时 onDone 触发的保存拿到最终消息内容。
 */
function schedulePersist() {
  // 只读画布（外部白板格式）永不落盘：内容来自原 .canvas 文件，本应用不写该格式
  if (useCanvasStore.getState().readOnly) return;
  const targetCanvasId = useCanvasStore.getState().canvasId;
  const targetCanvasFile = useCanvasStore.getState().canvasFile;
  if (!targetCanvasId || !targetCanvasFile) return;
  if (saveTimer) clearTimeout(saveTimer);
  useCanvasStore.setState({ saving: true, dirty: true });
  saveTimer = setTimeout(() => {
    const { canvasId, canvasFile, canvasTitle, nodes, edges, messagesByConv, baseUpdatedAt } =
      useCanvasStore.getState();
    // 保存目标已切换（load 会清 timer，此处兜底）：跳过，避免旧画布改动写入新画布
    if (canvasId !== targetCanvasId || canvasFile !== targetCanvasFile) {
      useCanvasStore.setState({ saving: false });
      return;
    }
    persistCanvasVault(canvasId, canvasFile, canvasTitle, nodes, edges, messagesByConv, baseUpdatedAt)
      .then((newUpdatedAt) => {
        lastSelfSaveAt = Date.now();
        // 同步乐观锁基准为本次写入的磁盘版本，避免下次保存误判冲突
        useCanvasStore.setState({ error: null, dirty: false, baseUpdatedAt: newUpdatedAt });
      })
      .catch((e) => {
        if (typeof e === "string" && e.includes("已被外部修改")) {
          // 乐观锁冲突：不覆盖磁盘，提示用户重载（本地改动保留在内存供查看）
          useCanvasStore.setState({ conflictPending: true });
          return;
        }
        console.error("自动保存失败", e);
        useCanvasStore.setState({ error: "自动保存失败，请检查磁盘空间或权限" });
      })
      .finally(() => {
        useCanvasStore.setState({ saving: false });
      });
  }, 500);
}

/** 边锚点自适应：按两节点中心相对方位重写 handle（与 ConnectionFrame 命名对齐）。 */
function withHandles<
  T extends {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }
>(edge: T, nodes: Node[]): T {
  const src = nodes.find((n) => n.id === edge.source);
  const tgt = nodes.find((n) => n.id === edge.target);
  if (!src || !tgt) return edge;
  const { sourceHandle, targetHandle } = pickEdgeHandles(
    { x: src.position.x, y: src.position.y, w: src.measured?.width ?? 200, h: src.measured?.height ?? 100 },
    { x: tgt.position.x, y: tgt.position.y, w: tgt.measured?.width ?? 200, h: tgt.measured?.height ?? 100 }
  );
  return { ...edge, sourceHandle, targetHandle };
}

/** 重算与指定节点相连的边锚点；有变化返回新 edges，无变化返回 null（避免无谓 set）。 */
function recalcEdgeHandles(edges: Edge[], nodes: Node[], nodeIds: Set<string>): Edge[] | null {
  const next = edges.map((e) => {
    if (!nodeIds.has(e.source) && !nodeIds.has(e.target)) return e;
    return withHandles(e, nodes);
  });
  return next.some((e, i) => e.sourceHandle !== edges[i].sourceHandle || e.targetHandle !== edges[i].targetHandle)
    ? next
    : null;
}

/** 各对话节点的 AbortController，模块级。 */
const abortControllers = new Map<string, AbortController>();

/**
 * 中止全部进行中的流（切画布/删节点/undo 用）。
 * abort() 后 streamChat 走 onDone（异步），其内部 cancelRaf + 清理 streamingByConv；
 * 此处同步清空 map/流式标志，避免 abort 与 load 的 set 之间的渲染残留。
 */
function abortAllStreams() {
  for (const controller of abortControllers.values()) controller.abort();
  abortControllers.clear();
}

/** 搜索结果产物节点：对话右侧 findFreeSpot 落点 + 对话→search 边。
 * 走 silent set（不 pushUndo）：工具产物属业务操作（同 send 的影子节点），
 * 入 undo 栈会与 tool 回填消息撕裂（撤销节点但消息仍在）。 */
function createSearchNode(conversationId: string, query: string, data: SearchResultData) {
  const store = useCanvasStore.getState();
  const convNode = store.nodes.find((n) => n.id === conversationId);
  if (!convNode) return;
  const id = crypto.randomUUID();
  const spot = findFreeSpot(
    store.nodes,
    { x: convNode.position.x + 480, y: convNode.position.y },
    { w: 280, h: 220 }
  );
  const node: Node = { id, type: "search", position: spot, data: { ...data, query } };
  // withHandles 传入含新节点的列表：target（search 节点）能找到，边锚点自适应
  const nextNodes = [...store.nodes, node];
  const edge = withHandles(
    {
      id: crypto.randomUUID(),
      source: conversationId,
      target: id,
      sourceHandle: null,
      targetHandle: null,
    },
    nextNodes
  );
  useCanvasStore.setState((s) => ({ nodes: [...s.nodes, node], edges: [...s.edges, edge] }));
  schedulePersist();
}

/** 画布对话节点实时查找（命名管线回调共用：延迟后/写回前重取，已删除/切画布返回 undefined）。 */
function findConversationNode(conversationId: string): Node | undefined {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === conversationId);
  return node && node.type === "conversation" ? node : undefined;
}

/**
 * LLM 话题自动命名：一轮对话完成后为对话节点生成话题标题。
 * - 仅对尚无 title 的对话节点命名（首轮完成后一次，之后不覆盖）
 * - 统一走 streaming.ts 的公共命名管线（模型解析/延迟/超时与面板共用）
 * - fire-and-forget：无可用模型/命名失败降级保留占位，不阻塞画布操作
 */
async function autoNameConversation(conversationId: string): Promise<void> {
  await runAutoNaming({
    getMessages: () => {
      const node = findConversationNode(conversationId);
      if (!node) return [];
      return useCanvasStore.getState().messagesByConv[conversationId] ?? [];
    },
    isNamed: () => {
      const node = findConversationNode(conversationId);
      return !node || !!((node.data as Partial<ConversationData>).title);
    },
    applyTitle: (title) => {
      const node = findConversationNode(conversationId);
      if (!node) return;
      useCanvasStore.getState().updateNodeData(conversationId, { title });
    },
  });
}

/**
 * 流式执行一轮对话：预建 assistant 消息 → 按注入语义组装 messages → SSE 流式写入。
 * send 与 regenerate 共用（流式输出/停止；5.4：引用注入 user 消息）。
 *
 * 性能与状态正确性要点：
 * - onDelta 用 rAF 合并高频 token，避免每 token 一次 setState 卡 UI。
 * - abort/空回复：移除占位 assistant，避免残留空气泡（streamChat 在 abort 时走 onDone）。
 * - 错误：占位 assistant 写入 `[错误] …` 并随 .atlx 持久化；下次请求历史过滤此类消息，不污染上下文。
 * - 持久化：messages 嵌在对话节点 data 内，随 schedulePersist 整体写 .atlx，不再单条 upsert。
 */
async function runStream(conversationId: string): Promise<void> {
  const store = useCanvasStore;

  // 节点级 provider/model 优先，未指定则跟随仓库默认；解析失败（供应商已删/未配置）提示并中止，
  // 不静默回落默认——统一走 settingsStore.resolveChatTarget（与 AI 对话面板同源）
  const nodeData = store
    .getState()
    .nodes.find((n) => n.id === conversationId)?.data as Partial<ConversationData> | undefined;
  const resolved = useSettingsStore.getState().resolveChatTarget(
    nodeData?.providerId || nodeData?.model
      ? { providerId: nodeData.providerId || undefined, model: nodeData.model || undefined }
      : null
  );
  if (!resolved.ok) {
    store.setState({ error: resolved.error });
    return;
  }
  const { provider, model } = resolved;

  // 预创建 assistant 消息（流式追加内容）
  const { id: asstId, ts: asstTs } = nowId();
  const list = store.getState().messagesByConv[conversationId] ?? [];
  store.setState({
    messagesByConv: {
      ...store.getState().messagesByConv,
      [conversationId]: [...list, { id: asstId, conversationId, role: "assistant", content: "", createdAt: asstTs }],
    },
    streamingByConv: { ...store.getState().streamingByConv, [conversationId]: true },
  });

  const controller = new AbortController();
  abortControllers.set(conversationId, controller);

  // 5.4：引用已在 send 时固化进 user 消息 content（一次性注入），此处不再动态拼接
  // 过滤 system 与错误占位 assistant（[错误] 不进 API 历史，避免污染上下文）；
  // 空占位 assistant（预建 content:"" 的流式占位）也不发送——部分端点对空 content 返回 400
  const history = store.getState().messagesByConv[conversationId].filter(
    (m) =>
      m.role !== "system" &&
      !(m.role === "assistant" && (m.content.startsWith("[错误]") || m.content === ""))
  );

  try {
    // 工具开关：节点级显式开启且搜索源已配置才携带 tools；开着但未配置 → 提示并降级不带 tools
    const settings = useSettingsStore.getState();
    const toolsWanted = !!nodeData?.toolsEnabled;
    const searchReady = settings.isSearchConfigured();
    if (toolsWanted && !searchReady) {
      store.setState({ error: "未配置搜索源（设置 → 联网搜索），本次对话未启用联网搜索" });
    }
    const tools = toolsWanted && searchReady ? [WEB_SEARCH_TOOL] : undefined;
    // 5.4：引用已在 send 时固化进 user 消息 content（一次性注入），此处不再动态拼接
    const apiMessages: ChatParams["messages"] = toApiMessages(history);
    // 系统提示词：从引用的笔记实时读正文，注入为首条 system 消息（外部编辑即时生效）。
    // 读失败（笔记被删/改名）静默降级为不带系统提示词，不阻塞对话。
    if (nodeData?.systemPromptFile) {
      try {
        const sysContent = await readNote(nodeData.systemPromptFile);
        if (sysContent.trim()) apiMessages.unshift({ role: "system", content: sysContent });
      } catch {
        // 笔记缺失：跳过注入
      }
    }
    await runStreamExchange({
      provider,
      model,
      apiMessages,
      ...(tools ? { tools } : {}),
      signal: controller.signal,
      // 增量写入占位消息（引擎 rAF 合并后每帧调用）
      applyBatch: ({ content, reasoning }) => {
        store.setState((state) => {
          const l = state.messagesByConv[conversationId] ?? [];
          return {
            messagesByConv: {
              ...state.messagesByConv,
              [conversationId]: l.map((m) =>
                m.id === asstId
                  ? {
                      ...m,
                      ...(content ? { content: m.content + content } : {}),
                      ...(reasoning
                        ? { reasoningContent: (m.reasoningContent ?? "") + reasoning }
                        : {}),
                    }
                  : m
              ),
            },
          };
        });
      },
      onError: (err) => {
        // 不静默降级：请求失败如实报错（[错误] 占位显示服务端具体信息，便于定位）
        store.setState((state) => {
          const l = state.messagesByConv[conversationId] ?? [];
          return {
            messagesByConv: {
              ...state.messagesByConv,
              [conversationId]: l.map((m) =>
                m.id === asstId
                  ? { ...m, content: m.content || `[错误] ${err.message}` }
                  : m
              ),
            },
            streamingByConv: { ...state.streamingByConv, [conversationId]: false },
          };
        });
        // 持久化错误占位（[错误] 前缀会在下次请求历史中被过滤，不污染上下文）
        schedulePersist();
        abortControllers.delete(conversationId);
      },
      onDone: ({ content, reasoning, timedOut }) => {
        // 空回复移除占位；超时且回答未产出写超时降级（保留思考）；否则正常复位
        const decision = decideCleanup(content, reasoning, timedOut);
        if (decision.kind === "remove") {
          store.setState((state) => {
            const l = state.messagesByConv[conversationId] ?? [];
            return {
              messagesByConv: {
                ...state.messagesByConv,
                [conversationId]: l.filter((m) => m.id !== asstId),
              },
              streamingByConv: { ...state.streamingByConv, [conversationId]: false },
            };
          });
        } else if (decision.kind === "timeout-error") {
          store.setState((state) => {
            const l = state.messagesByConv[conversationId] ?? [];
            return {
              messagesByConv: {
                ...state.messagesByConv,
                [conversationId]: l.map((m) =>
                  m.id === asstId
                    ? { ...m, content: "[错误] 响应超时（长时间无输出，已自动停止）" }
                    : m
                ),
              },
              streamingByConv: { ...state.streamingByConv, [conversationId]: false },
            };
          });
        } else {
          store.setState((state) => ({
            streamingByConv: { ...state.streamingByConv, [conversationId]: false },
          }));
        }
        // messages 随 .atlx 整体写（替代旧 upsertMessage/deleteMessage 单条持久化）
        schedulePersist();
        abortControllers.delete(conversationId);
      },
      executeTools: async (calls) => {
        // 执行工具调用：web_search → 产物节点（SearchResultNode）+ tool 消息回填给 AI。
        // 搜索走 Rust 代理（invoke 不支持 AbortSignal）：用户点停止后，已发出的请求结果回来时
        // 被下方 aborted 检查丢弃（不建节点），引擎下一轮携已 abort 的 signal 立即收敛。
        const toolMessages: ChatParams["messages"] = [];
        for (const tc of calls) {
          let query = "";
          try {
            query = (JSON.parse(tc.function.arguments) as { query?: string }).query ?? "";
          } catch {
            // 参数解析失败：按空 query 处理（下方产生失败节点）
          }
          const data = query
            ? await runSearch(useSettingsStore.getState().searchConfig, query)
            : { query: "", results: [], error: "搜索参数解析失败" };
          // 用户已点停止：不创建「搜索失败」节点（abort 后 runSearch 降级为 error，属预期中止而非失败）
          if (controller.signal.aborted) break;
          if (data.results.length > 0 || data.error) {
            createSearchNode(conversationId, data.query || query || "搜索", data);
          }
          toolMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: data.error ? `搜索失败：${data.error}` : JSON.stringify(data.results),
          });
        }
        return toolMessages;
      },
    });
  } catch (e) {
    console.error("流式请求失败", e);
    store.setState((state) => ({
      streamingByConv: { ...state.streamingByConv, [conversationId]: false },
    }));
    abortControllers.delete(conversationId);
  }
}

function nowId() {
  return { id: crypto.randomUUID(), ts: Date.now() };
}

/** 引用节点 → 最新注入内容（regenerate 重建用）：text 取 bodyMd；媒体图片取 name + thumb，文本类取 body；search 取结果摘要；table 取快照。 */
function latestRefOf(node: Node): { text: string; attach?: Attachment } | null {
  if (node.type === "text") {
    const d = node.data as unknown as TextData;
    return d.bodyMd ? { text: d.bodyMd } : null;
  }
  if (node.type === "search") {
    const text = resultsToText(node.data as unknown as SearchResultData);
    return text ? { text } : null;
  }
  if (node.type === "table") {
    const td = node.data as unknown as TableData;
    const snapshot = td.snapshot || td.title;
    return snapshot ? { text: snapshot } : null;
  }
  const md = node.data as unknown as MediaData;
  if (md.kind === "image" && md.thumb) {
    return {
      text: md.name ?? "",
      attach: { kind: "image", payload: md.thumb, mime: md.mime, filename: md.name },
    };
  }
  if (md.body) return { text: md.body };
  return null;
}

/**
 * 用最新资产状态重建最后一条 user 消息（regenerate 前调用，扩展）：
 * - @提及（refs.label 作为 `@显示名` 出现在 displayContent）：就地替换为最新内容——
 *   与 send 侧 `String.replace(m.text, …)` 同为「首处子串替换」语义，保持行为一致
 * - 正向连边引用（label 不在 displayContent）：重拼 `[引用：…]` 前缀
 * - 附件：画布媒体节点引用（sourceNodeId）替换为最新 thumb/body，临时附件保留
 * 源节点缺失/读不到内容时跳过（保持旧快照，不崩坏）。
 * 注意：调用方须保证 userMsg.displayContent 存在（重建以原始输入为基底，缺失时无法反推 @位置）。
 */
function rebuildUserContent(
  userMsg: Message,
  nodes: Node[]
): { content: string; attachments?: Attachment[] } {
  let content = userMsg.displayContent as string;
  const prefixParts: string[] = [];
  const attachByNode = new Map<string, Attachment>();
  for (const ref of userMsg.refs ?? []) {
    const node = nodes.find((n) => n.id === ref.nodeId);
    if (!node) continue;
    const latest = latestRefOf(node);
    if (!latest) continue;
    const tag = `@${ref.label}`;
    if (content.includes(tag)) {
      // 函数形式替换：latest.text 若含 `$`/`&` 不会被 String.replace 当作替换模式解析
      content = content.replace(tag, () => latest.text);
      // 保留 sourceNodeId：附件来自画布媒体节点（@ 提及），供「已注入」检测与语义完整
      if (latest.attach) attachByNode.set(ref.nodeId, { ...latest.attach, sourceNodeId: ref.nodeId });
    } else {
      prefixParts.push(latest.text);
    }
  }
  if (prefixParts.length) content = `[引用：${prefixParts.join("\n\n")}]\n\n${content}`;
  const attachments = (userMsg.attachments ?? []).map((a) =>
    a.sourceNodeId ? (attachByNode.get(a.sourceNodeId) ?? a) : a
  );
  return { content, attachments: attachments.length ? attachments : undefined };
}

function snapshot(
  nodes: Node[],
  edges: Edge[],
  messagesByConv: Record<string, Message[]>
): Snapshot {
  return {
    nodes: structuredClone(nodes),
    edges: structuredClone(edges),
    messagesByConv: structuredClone(messagesByConv),
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  canvasId: null,
  canvasFile: null,
  canvasTitle: "",
  nodes: [],
  edges: [],
  readOnly: false,
  messagesByConv: {},
  streamingByConv: {},
  pendingMentionsByConv: {},
  pendingConfirmByConv: {},
  error: null,
  selectedNodeId: null,
  loading: false,
  saving: false,
  dirty: false,
  conflictPending: false,
  baseUpdatedAt: 0,
  undoStack: [],
  redoStack: [],
  load: async (file) => {
    // 切换画布前先取消未落盘的保存定时器：timer 回调读最新 state（canvasId 已是新画布），
    // 不清会导致旧画布最后改动丢失且新画布被意外保存（P0 数据丢失）
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    // 中止旧画布进行中的流：abort 后 onDone 只清流式标志，不再向新画布写增量
    abortAllStreams();
    // 中止旧画布进行中的命名请求（防其后台空转/误写；与面板 load 对称）
    abortAutoTitle();
    set({ loading: true, error: null, selectedNodeId: null });
    try {
      // 外部白板格式（.canvas）走只读加载：映射为运行时节点 + 无向边，永不落盘
      const isWhiteboard = file.toLowerCase().endsWith(".canvas");
      const data = isWhiteboard ? await loadWhiteboardVault(file) : await loadCanvasVault(file);
      set({
        canvasId: data.id,
        canvasFile: file,
        canvasTitle: data.title,
        nodes: data.nodes,
        edges: data.edges,
        readOnly: isWhiteboard,
        messagesByConv: data.messagesByConv,
        // 乐观并发基准 = 磁盘版本；加载后本地与磁盘一致
        baseUpdatedAt: data.updatedAt,
        dirty: false,
        conflictPending: false,
        // 跨画布切换清空 undo/redo 与流式状态：快照含 messages，混用会串画布污染撤销
        undoStack: [],
        redoStack: [],
        streamingByConv: {},
        loading: false,
      });
      // 恢复补命名：加载后对首个未命名对话节点重试（覆盖上次命名被中断/丢失的窗口；
      // 仅补一个防并发请求轰炸模型端点）；无 title 无消息的节点由消息检查自然跳过
      if (!isWhiteboard) {
        const unnamed = get().nodes.find(
          (n) => n.type === "conversation" && !((n.data as Partial<ConversationData>).title),
        );
        if (unnamed) void autoNameConversation(unnamed.id);
      }
    } catch (e) {
      console.error("加载画布失败", e);
      set({ loading: false, error: "加载画布失败，请重试" });
    }
  },
  renameCanvas: async (title) => {
    const { canvasId, canvasFile } = get();
    // 只读画布（外部白板格式）不支持重命名（文件保留不动）
    if (!canvasId || !canvasFile || get().readOnly) return;
    set({ canvasTitle: title });
    try {
      await renameCanvasVault(canvasFile, title);
      // 软件内重命名写 .atlx 文件，标记自写抑制 watcher 误报 + 同步乐观锁基准防下次保存误冲突
      markSelfSave();
      // 同目录改文件名：同步 canvasFile 到新路径（防下次保存写旧路径 → createdAt 重置/乐观锁失效/
      // 外部修改失配）；appStore.currentCanvasFile 同源（打开路径/文件面板高亮），一并同步
      const newFile = siblingPath(canvasFile, `${sanitizeFilename(title)}.atlx`);
      set({ canvasFile: newFile });
      if (useAppStore.getState().currentCanvasFile === canvasFile) {
        useAppStore.setState({ currentCanvasFile: newFile });
      }
      await get().syncBaseUpdatedAt();
    } catch (e) {
      console.error("重命名失败", e);
    }
  },
  onNodesChange: (changes) => {
    // 只读画布：只保留选中态变化（禁拖拽/缩放产生的位置尺寸变更，防白板内容被改动）
    const changesNow = get().readOnly ? changes.filter((c) => c.type === "select") : changes;
    const nodes = applyNodeChanges(changesNow, get().nodes);
    set({ nodes });
    // resize 结束（dimensions + resizing:false）：重算相连边锚点（与 onNodeDragStop 对称）
    const resized = new Set(
      changesNow
        .filter((c) => c.type === "dimensions")
        .filter((c) => c.resizing === false)
        .map((c) => c.id)
    );
    if (resized.size > 0) {
      const next = recalcEdgeHandles(get().edges, nodes, resized);
      if (next) {
        set({ edges: next });
        schedulePersist();
        return;
      }
    }
    // 纯选中变化（select）不落盘：点选/框选节点不应触发 .atlx 写入与「保存中」闪烁
    if (changesNow.some((c) => c.type !== "select")) schedulePersist();
  },
  onEdgesChange: (changes) => {
    const edges = applyEdgeChanges(changes, get().edges);
    set({ edges });
    if (changes.some((c) => c.type !== "select")) schedulePersist();
  },
  onConnect: (connection: Connection) => {
    const { nodes, edges, messagesByConv } = get();
    const src = nodes.find((n) => n.id === connection.source);
    const tgt = nodes.find((n) => n.id === connection.target);
    // 拖线引用（text/media/search → conversation）：引用即边——未连接时立即建虚线边（未消费自动虚线）
    // + 输入框 @标签 队列（消费后由虚实判定自动转实线，取消引用=删 @标签断边）
    if (
      tgt?.type === "conversation" &&
      (src?.type === "text" || src?.type === "media" || src?.type === "search")
    ) {
      const alreadyConnected = edges.some(
        (e) => e.target === connection.target && e.source === connection.source
      );
      if (alreadyConnected) {
        // 已连接：该资产已被消费过（实线边）→ 弹「再次注入」菜单；未消费（虚线待发送）→ 无效果（防同轮重复引用）
        const injected = isAssetConsumed(messagesByConv[connection.target] ?? [], connection.source);
        if (injected) {
          set((state) => ({
            pendingConfirmByConv: {
              ...state.pendingConfirmByConv,
              [connection.target]: [...(state.pendingConfirmByConv[connection.target] ?? []), connection.source],
            },
          }));
        }
        return;
      }
      // 未连接：立即建边（不入 undo 栈——取消引用 = 删 @标签自动断边，无需撤销）+ 输入框 @标签
      const nodesNow = get().nodes;
      const edge = withHandles({ ...connection, animated: false }, nodesNow);
      set({ edges: rfAddEdge(edge, get().edges) });
      get().queueMention(connection.target, connection.source);
      schedulePersist();
      return;
    }
    // 自动分类：仅「对话 → 资产」是有向数据流产出边；其余连线（对话↔对话、link/group 参与、
    // 无对话组合）均为关联自由线（directed: false，无消费语义、可删除、箭头模式 linkMode）
    const isDataFlow = src?.type === "conversation" &&
      (tgt?.type === "text" || tgt?.type === "media" || tgt?.type === "search");
    get().pushUndo();
    const nodesNow = get().nodes;
    const edge = withHandles(
      { ...connection, animated: false, ...(isDataFlow ? {} : { directed: false, linkMode: "none" as const }) },
      nodesNow
    );
    const nextEdges = rfAddEdge(edge, get().edges);
    set({ edges: nextEdges });
    schedulePersist();
  },
  queueMention: (conversationId, nodeId) => {
    set((state) => ({
      pendingMentionsByConv: {
        ...state.pendingMentionsByConv,
        [conversationId]: [...(state.pendingMentionsByConv[conversationId] ?? []), nodeId],
      },
    }));
  },
  clearPendingMentions: (conversationId) => {
    set((state) => {
      const next = { ...state.pendingMentionsByConv };
      delete next[conversationId];
      return { pendingMentionsByConv: next };
    });
  },
  confirmConnect: (conversationId, nodeId) => {
    // 再次注入：走正常引用流程（输入框 @标签；边已存在——不可手动断开，消费后虚实自动转实线）
    get().queueMention(conversationId, nodeId);
    set((state) => {
      const list = state.pendingConfirmByConv[conversationId] ?? [];
      const next = { ...state.pendingConfirmByConv };
      if (list.length <= 1) delete next[conversationId];
      else next[conversationId] = list.filter((n) => n !== nodeId);
      return { pendingConfirmByConv: next };
    });
  },
  clearPendingConfirm: (conversationId) => {
    set((state) => {
      const next = { ...state.pendingConfirmByConv };
      delete next[conversationId];
      return { pendingConfirmByConv: next };
    });
  },
  onNodeDragStart: () => {
    get().pushUndo();
  },
  onNodeDragStop: (_, node) => {
    const next = recalcEdgeHandles(get().edges, get().nodes, new Set([node.id]));
    if (next) {
      set({ edges: next });
      schedulePersist();
    }
  },
  addNode: (node) => {
    get().pushUndo();
    const nodes = [...get().nodes, node];
    set({ nodes });
    schedulePersist();
  },
  addTextNoteFromVault: async (file, title, position, exact = false) => {
    let bodyMd = "";
    let fileMissing = false;
    try {
      bodyMd = await readNote(file);
    } catch {
      // 文件缺失/读取失败：标 fileMissing，TextNode 显示「文件缺失」降级
      fileMissing = true;
    }
    // 拖拽落点精确（exact=true 跳过避让，保证节点落在鼠标位置）；其他入口走 findFreeSpot 避让
    const spot = exact ? position : findFreeSpot(get().nodes, position, { w: 320, h: 240 });
    get().addNode({
      id: crypto.randomUUID(),
      type: "text",
      position: spot,
      // 显式写入默认尺寸：React Flow 优先用节点存储的 width/height（TextNode 的 ?? 回退受测量机制干扰）
      width: DEFAULT_TEXT_NODE_WIDTH,
      height: DEFAULT_TEXT_NODE_HEIGHT,
      data: { title, file, bodyMd, fileMissing } as unknown as Node["data"],
    });
  },
  importAttachment: (src, name) => importAttachmentVault(src, name),
  pickAndImportAttachment: async (position: { x: number; y: number }) => {
    const picked = await pickFile();
    if (!picked) return false;
    const name = picked.split(/[\\/]/).pop() ?? "未命名";
    const file = await importAttachmentVault(picked, name);
    await get().addMediaFromVault(file, name, position);
    return true;
  },
  addMediaFromVault: async (file, name, position, exact = false) => {
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(name);
    let data: MediaData;
    if (isImage) {
      try {
        const thumb = await readAttachmentDataUrl(file);
        const mime = inferImageMime(name);
        data = { file, kind: "image", mime, thumb, name };
      } catch (e) {
        console.error("读图片附件失败", e);
        return;
      }
    } else {
      // 文本类附件：尝试读内容；二进制读失败标 parseFailed
      let body: string | undefined;
      let parseFailed = false;
      try {
        body = await readNote(file);
      } catch {
        parseFailed = true;
      }
      data = { file, kind: "file", mime: "text/plain", name, body, parseFailed };
    }
    // 拖拽落点精确（exact=true 跳过避让）；其他入口走 findFreeSpot 避让
    const spot = exact ? position : findFreeSpot(get().nodes, position, { w: 260, h: 240 });
    get().addNode({
      id: crypto.randomUUID(),
      type: "media",
      position: spot,
      data: data as unknown as Node["data"],
    });
  },
  findTextNoteByFile: (file) => {
    const node = get().nodes.find(
      (n) => n.type === "text" && (n.data as unknown as TextData).file === file
    );
    return node?.id ?? null;
  },
  findMediaNoteByFile: (file) => {
    const node = get().nodes.find(
      (n) => n.type === "media" && (n.data as unknown as MediaData).file === file
    );
    return node?.id ?? null;
  },
  addTableFromVault: async (file, title, position, exact = false) => {
    let snapshot = "";
    let fileMissing = false;
    try {
      snapshot = tableToSnapshotText(await readTableVault(file));
    } catch {
      // 文件缺失/读取失败：标 fileMissing，TableNode 显示「文件缺失」降级
      fileMissing = true;
    }
    // 拖拽落点精确（exact=true 跳过避让）；其他入口走 findFreeSpot 避让
    const spot = exact ? position : findFreeSpot(get().nodes, position, { w: 320, h: 240 });
    get().addNode({
      id: crypto.randomUUID(),
      type: "table",
      position: spot,
      width: DEFAULT_TABLE_NODE_WIDTH,
      height: DEFAULT_TABLE_NODE_HEIGHT,
      data: { title, file, snapshot, fileMissing } as unknown as Node["data"],
    });
  },
  refreshTableContent: async (file) => {
    // 同一 .atb 可被多个 table 节点引用（同画布多节点），全部刷新（与 refreshTextContent 同构）
    const ids = get()
      .nodes.filter((n) => n.type === "table" && (n.data as unknown as TableData).file === file)
      .map((n) => n.id);
    if (ids.length === 0) return;
    try {
      const snapshot = tableToSnapshotText(await readTableVault(file));
      // silent set：直接改 nodes，不调 schedulePersist（变更来自磁盘，写回会回环）
      set((s) => ({
        nodes: s.nodes.map((n) =>
          ids.includes(n.id)
            ? { ...n, data: { ...n.data, snapshot, fileMissing: false } as unknown as Node["data"] }
            : n
        ),
      }));
    } catch {
      get().markFileMissing(file, "table");
    }
  },
  refreshTextContent: async (file) => {
    // 同一 .md 可被多个 text 节点引用（同画布多节点），全部刷新（与 markFileMissing 更新全部节点同构）
    const ids = get()
      .nodes.filter((n) => n.type === "text" && (n.data as unknown as TextData).file === file)
      .map((n) => n.id);
    if (ids.length === 0) return;
    try {
      const bodyMd = await readNote(file);
      // silent set：直接改 nodes，不调 schedulePersist（变更来自磁盘，写回会回环）
      set((s) => ({
        nodes: s.nodes.map((n) =>
          ids.includes(n.id)
            ? { ...n, data: { ...n.data, bodyMd, fileMissing: false } as unknown as Node["data"] }
            : n
        ),
      }));
    } catch {
      get().markFileMissing(file, "text");
    }
  },
  refreshMediaContent: async (file) => {
    // 同一附件可被多个 media 节点引用，全部刷新（与 markFileMissing 同构）
    const ids = get()
      .nodes.filter((n) => n.type === "media" && (n.data as unknown as MediaData).file === file)
      .map((n) => n.id);
    if (ids.length === 0) return;
    try {
      const existing = get().nodes.find((n) => n.id === ids[0])?.data as unknown as MediaData;
      if (existing.kind === "image") {
        const thumb = await readAttachmentDataUrl(file);
        set((s) => ({
          nodes: s.nodes.map((n) =>
            ids.includes(n.id)
              ? { ...n, data: { ...n.data, thumb, fileMissing: false } as unknown as Node["data"] }
              : n
          ),
        }));
      } else {
        const body = await readNote(file);
        set((s) => ({
          nodes: s.nodes.map((n) =>
            ids.includes(n.id)
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    body,
                    parseFailed: false,
                    fileMissing: false,
                  } as unknown as Node["data"],
                }
              : n
          ),
        }));
      }
    } catch {
      get().markFileMissing(file, "media");
    }
  },
  markFileMissing: (file, kind) => {
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (kind === "text" && n.type === "text" && (n.data as unknown as TextData).file === file) {
          return { ...n, data: { ...n.data, fileMissing: true } as unknown as Node["data"] };
        }
        if (
          kind === "media" &&
          n.type === "media" &&
          (n.data as unknown as MediaData).file === file
        ) {
          return { ...n, data: { ...n.data, fileMissing: true } as unknown as Node["data"] };
        }
        if (
          kind === "table" &&
          n.type === "table" &&
          (n.data as unknown as TableData).file === file
        ) {
          return { ...n, data: { ...n.data, fileMissing: true } as unknown as Node["data"] };
        }
        return n;
      }),
    }));
  },
  reloadFromDisk: async () => {
    const { canvasFile } = get();
    if (!canvasFile) return;
    // 重载后与磁盘一致：清冲突与脏标记（本地未保存改动被丢弃，由用户确认后调用）
    set({ conflictPending: false, dirty: false });
    await get().load(canvasFile);
  },

  mergeFromDisk: async () => {
    const { canvasFile } = get();
    if (!canvasFile) return;
    const localNodes = get().nodes;
    const localEdges = get().edges;
    const localMessages = get().messagesByConv;
    // 先加载磁盘最新作为合并基底（load 会把 baseUpdatedAt 同步为磁盘版本）
    await get().load(canvasFile);
    const diskNodes = get().nodes;
    const diskEdges = get().edges;
    const diskMessages = get().messagesByConv;
    const diskNodeIds = new Set(diskNodes.map((n) => n.id));
    const diskEdgeIds = new Set(diskEdges.map((e) => e.id));
    // 合并：磁盘为基础，本地新增的节点/边保留；重叠（同 id）以磁盘为准（外部修改优先）
    const mergedNodes = [...diskNodes, ...localNodes.filter((n) => !diskNodeIds.has(n.id))];
    const mergedEdges = [...diskEdges, ...localEdges.filter((e) => !diskEdgeIds.has(e.id))];
    // 消息：磁盘为基础，本地独有的消息按 id 补入（避免丢用户未保存的消息）
    const mergedMessages: Record<string, Message[]> = { ...diskMessages };
    for (const [convId, msgs] of Object.entries(localMessages)) {
      const diskMsgs = diskMessages[convId] ?? [];
      const diskIds = new Set(diskMsgs.map((m) => m.id));
      const extras = msgs.filter((m) => !diskIds.has(m.id));
      if (extras.length) mergedMessages[convId] = [...diskMsgs, ...extras];
    }
    set({
      nodes: mergedNodes,
      edges: mergedEdges,
      messagesByConv: mergedMessages,
      conflictPending: false,
      dirty: true,
    });
    // 合并产物立即落盘（baseUpdatedAt 已在 load 时同步为磁盘版本，不会误冲突）
    schedulePersist();
  },
  addEdge: (edge) => {
    get().pushUndo();
    const edges = [...get().edges, withHandles(edge, get().nodes)];
    set({ edges });
    schedulePersist();
  },
  updateNodeData: (nodeId, patch) => {
    const nodes = get().nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n
    );
    set({ nodes });
    schedulePersist();
  },
  syncBaseUpdatedAt: async () => {
    const canvasFile = get().canvasFile;
    if (!canvasFile) return;
    try {
      const disk = await readCanvasVault(canvasFile);
      set({ baseUpdatedAt: disk.updatedAt });
    } catch {
      // 画布被外部删除等情况：保持现状，reload/切换路径会处理
    }
  },
  getReferencedInputs: (conversationId) => {
    const { nodes, edges } = get();
    // 跳过「连接」模式边（inject:false，仅连线不注入）与无向边（directed:false，白板连线无消费语义）
    const upstream = edges.filter(
      (e) =>
        e.target === conversationId &&
        e.directed !== false &&
        (e.data as { inject?: boolean } | undefined)?.inject !== false
    );
    const inputs: ReferencedInput[] = [];
    for (const edge of upstream) {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) continue;
      const data = sourceNode.data as unknown;
      if (sourceNode.type === "text") {
        const bodyMd = (data as TextData).bodyMd;
        if (bodyMd) {
          inputs.push({ nodeId: sourceNode.id, label: prefix(bodyMd) || "文本", content: bodyMd });
        }
      } else if (sourceNode.type === "search") {
        // 搜索结果节点：注入勾选子集或全部结果的文本摘要
        const text = resultsToText(data as SearchResultData);
        if (text) {
          inputs.push({
            nodeId: sourceNode.id,
            label: prefix((data as SearchResultData).query) || "搜索",
            content: text,
          });
        }
      } else if (sourceNode.type === "table") {
        // 表格节点：注入快照（字段名 + 每行值，行限 MAX_TABLE_INJECT_ROWS）
        const td = data as unknown as TableData;
        const content = td.snapshot || td.title;
        if (content) {
          inputs.push({ nodeId: sourceNode.id, label: td.title || "表格", content });
        }
      }
    }
    return inputs;
  },
  clearError: () => set({ error: null }),
  selectNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },
  setEdgeLinkMode: (edgeId, linkMode) => {
    // 只读白板禁编辑；样式切换只改边数据，随画布 debounce 落盘（不入 undo 栈）
    if (get().readOnly) return;
    set((s) => ({
      edges: s.edges.map((e) => (e.id === edgeId ? { ...e, linkMode } : e)),
    }));
    schedulePersist();
  },

  pushUndo: () => {
    const { nodes, edges, messagesByConv, undoStack } = get();
    const entry = snapshot(nodes, edges, messagesByConv);
    set({
      undoStack: [...undoStack, entry].slice(-MAX_UNDO),
      redoStack: [],
    });
  },

  send: async (conversationId, content, attachments = [], mentions = []) => {
    const { canvasId, messagesByConv, nodes } = get();
    if (!canvasId) return;

    // 让路：中止进行中的自动命名请求（防其占用后端槽位与新消息排队）
    abortAutoTitle();

    // 发送时自动连线（防御）：输入框 @提及 但尚未建边的引用此刻建立边（正常路径拖线/@picker 已立即建边，
    // 此处仅兜底异常路径）；源节点已被删除的提及不再建边（否则产生悬空边），该引用随之下沉丢弃
    const edgesNow = get().edges;
    const missing = mentions.filter(
      (m) =>
        !edgesNow.some((e) => e.target === conversationId && e.source === m.nodeId) &&
        nodes.some((n) => n.id === m.nodeId)
    );
    if (missing.length) {
      set({
        edges: [
          ...edgesNow,
          ...missing.map((m) =>
            withHandles(
              {
                id: crypto.randomUUID(),
                source: m.nodeId,
                target: conversationId,
                sourceHandle: null,
                targetHandle: null,
              },
              nodes
            )
          ),
        ],
      });
      schedulePersist();
    }

    // 5.4 就地替换：@提及 → 引用内容（文本节点正文 / 媒体附件），用户可见的 @显示名 位置即注入位置。
    // 用 scanMentionHits 按命中实例精确替换（重复 @提及 时不错位），从后往前替换避免位置漂移。
    let finalContent = content;
    const mentionRefs: ReferencedInput[] = [];
    const mentionAtts: PendingAttachment[] = [];
    const hits = scanMentionHits(content, mentions);
    for (let i = hits.length - 1; i >= 0; i--) {
      const { start, end, mention: m } = hits[i];
      const node = nodes.find((n) => n.id === m.nodeId);
      if (!node) continue;
      if (node.type === "text") {
        const bodyMd = (node.data as unknown as TextData).bodyMd;
        if (bodyMd) {
          finalContent = finalContent.slice(0, start) + bodyMd + finalContent.slice(end);
          mentionRefs.push({ nodeId: node.id, label: m.text.slice(1), content: bodyMd });
        }
      } else if (node.type === "media") {
        const md = node.data as unknown as MediaData;
        if (md.kind === "image" && md.thumb) {
          // 图片：文本位替换为文件名，图片本体随附件（vision）发送。
          // 引用此节点的附件已在托盘（拖线/@picker 均同时进托盘 + 输入框 @标记），
          // 这里只做文本位替换，不重复 push——否则同一图片会发两张。
          finalContent = finalContent.slice(0, start) + (md.name ?? "") + finalContent.slice(end);
          if (!attachments.some((a) => a.sourceNodeId === node.id)) {
            mentionAtts.push({
              id: crypto.randomUUID(),
              kind: "image",
              payload: md.thumb,
              mime: md.mime,
              filename: md.name,
              sourceNodeId: node.id,
            });
          }
        } else if (md.body) {
          finalContent = finalContent.slice(0, start) + md.body + finalContent.slice(end);
          mentionRefs.push({ nodeId: node.id, label: m.text.slice(1), content: md.body });
        }
      } else if (node.type === "search") {
        // 搜索结果节点：@提及 就地替换为结果摘要（勾选子集或全部，）
        const text = resultsToText(node.data as unknown as SearchResultData);
        if (text) {
          finalContent = finalContent.slice(0, start) + text + finalContent.slice(end);
          mentionRefs.push({ nodeId: node.id, label: m.text.slice(1), content: text });
        }
      } else if (node.type === "table") {
        // 表格节点：@提及 就地替换为快照（字段名 + 每行值，行限 MAX_TABLE_INJECT_ROWS）
        const td = node.data as unknown as TableData;
        const snapshot = td.snapshot || td.title;
        if (snapshot) {
          finalContent = finalContent.slice(0, start) + snapshot + finalContent.slice(end);
          mentionRefs.push({ nodeId: node.id, label: m.text.slice(1), content: snapshot });
        }
      }
    }
    mentionRefs.reverse(); // 从后往前处理后恢复按出现顺序
    mentionAtts.reverse(); // 同 mentionRefs：多图片附件保持 @提及 出现顺序

    // 未被 @提及 的入边引用（正向连边）仍拼到消息最前
    const edgeRefs = get().getReferencedInputs(conversationId);
    const already = new Set(mentionRefs.map((r) => r.nodeId));
    // 已消费（历史消息已注入过）的引用不重复注入——边消费后保留为实线，若不过滤，
    // 后续每条消息都会重拼 [引用：…] 前缀并在气泡里累计同样的 @chip（5.4 一次性语义）
    const historyMsgs = messagesByConv[conversationId] ?? [];
    const extraRefs = edgeRefs.filter(
      (r) => !already.has(r.nodeId) && !isAssetConsumed(historyMsgs, r.nodeId)
    );
    const refText = extraRefs.map((r) => r.content).filter(Boolean).join("\n\n");
    finalContent = refText ? `[引用：${refText}]\n\n${finalContent}` : finalContent;
    const refs = [...extraRefs, ...mentionRefs];
    const allAttachments = [...attachments, ...mentionAtts];

    // 影子节点预分配：无来源（临时附件，非画布节点引用）的附件发送后归档为画布媒体节点。
    // 提前分配节点 id 并写回消息附件的 sourceNodeId——DataFlowEdge 按
    // attachments.sourceNodeId 反推「已消费」命中（附件已随本消息注入），影子节点边显示实线。
    const shadowIds = new Map<PendingAttachment, string>();
    for (const a of allAttachments) {
      if (!a.sourceNodeId) shadowIds.set(a, crypto.randomUUID());
    }

    // 追加 user 消息
    const { id: userId, ts: userTs } = nowId();
    const userMsg: Message = {
      id: userId,
      conversationId,
      role: "user",
      content: finalContent,
      // 气泡显示原始输入（含 @提及 标记），避免展示就地替换后的一大篇正文
      displayContent: content,
      createdAt: userTs,
      attachments: allAttachments.length
        ? allAttachments.map((a) => {
            const { kind, payload, mime, filename, sourceNodeId } = a;
            return { kind, payload, mime, filename, sourceNodeId: sourceNodeId ?? shadowIds.get(a) };
          })
        : undefined,
      refs: refs.length ? refs.map((r) => ({ nodeId: r.nodeId, label: r.label })) : undefined,
    };
    set({
      messagesByConv: {
        ...messagesByConv,
        [conversationId]: [...(messagesByConv[conversationId] ?? []), userMsg],
      },
    });

    // 持久化 user 消息（随 .atlx 整体写）
    schedulePersist();

    // 影子节点：无来源的附件发送后静默归档为媒体节点，
    // 属业务操作，不进 Undo 栈，随画布自动保存落库。
    // 生成位置：对话节点左侧，用 findFreeSpot 自适应避开已有节点（含本批已添加的）。
    const shadows = allAttachments.filter((a) => !a.sourceNodeId);
    if (shadows.length) {
      const convNode = get().nodes.find((n) => n.id === conversationId);
      if (convNode) {
        const baseX = convNode.position.x - 310;
        const newNodes = [...get().nodes];
        const newEdges = [...get().edges];
        shadows.forEach((a) => {
          // 用消息附件里已写回的 shadowIds（保证 id 一致，消费反推能命中）
          const mediaId = shadowIds.get(a) ?? crypto.randomUUID();
          const spot = findFreeSpot(
            newNodes,
            { x: baseX, y: convNode.position.y },
            { w: 260, h: 240 }
          );
          newNodes.push({
            id: mediaId,
            type: "media",
            position: spot,
            data: {
              mime: a.mime,
              kind: a.kind,
              name: a.filename,
              thumb: a.kind === "image" ? a.payload : undefined,
              body: a.kind === "file" ? a.payload : undefined,
              parseFailed: a.parseFailed,
            },
          });
          newEdges.push(
            withHandles(
              {
                id: crypto.randomUUID(),
                source: mediaId,
                target: conversationId,
                sourceHandle: null,
                targetHandle: null,
              },
              newNodes
            )
          );
        });
        set({ nodes: newNodes, edges: newEdges });
        schedulePersist();
      }
    }

    await runStream(conversationId);
    // LLM 话题自动命名（首轮完成；fire-and-forget 不阻塞发送返回）
    void autoNameConversation(conversationId);
  },

  regenerate: async (conversationId) => {
    const list = get().messagesByConv[conversationId] ?? [];
    let lastUserIdx = -1;
    let lastAsstIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (lastAsstIdx < 0 && list[i].role === "assistant") lastAsstIdx = i;
      if (lastUserIdx < 0 && list[i].role === "user") lastUserIdx = i;
      if (lastUserIdx >= 0 && lastAsstIdx >= 0) break;
    }
    if (lastUserIdx < 0) return;

    // 5.4 扩展：最后一条 user 消息若引用了资产，用最新状态重建（文本/媒体内容与附件都可能已被
    // 编辑或外部修改，重新生成应基于最新上下文而非发送时的快照）。重建后随 .atlx 持久化。
    // displayContent 是重建基底（原始输入含 @标记）；旧消息无该字段时跳过（无法反推 @位置）。
    let nextList = list;
    const userMsg = list[lastUserIdx];
    if (userMsg.displayContent && userMsg.refs?.length) {
      const rebuilt = rebuildUserContent(userMsg, get().nodes);
      const changed =
        rebuilt.content !== userMsg.content ||
        JSON.stringify(rebuilt.attachments) !== JSON.stringify(userMsg.attachments);
      if (changed) {
        nextList = nextList.map((m) =>
          m.id === userMsg.id
            ? { ...m, content: rebuilt.content, attachments: rebuilt.attachments }
            : m
        );
      }
    }

    // 移除最后一条 assistant（内存 + 随 .atlx 持久化），随后重发最后一条 user。
    // 注意：重建与移除必须在同一份 nextList 上完成后再一次性 set——
    // 若各自基于旧 list 两次 set，第二次会覆盖重建结果（AI 仍用旧引用内容）。
    if (lastAsstIdx > lastUserIdx) {
      const asst = nextList[lastAsstIdx];
      nextList = nextList.filter((m) => m.id !== asst.id);
    }
    if (nextList !== list) {
      set({
        messagesByConv: {
          ...get().messagesByConv,
          [conversationId]: nextList,
        },
      });
      schedulePersist();
    }
    await runStream(conversationId);
  },

  rollbackTo: (conversationId, messageId) => {
    const list = get().messagesByConv[conversationId] ?? [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0 || idx === list.length - 1) return;
    get().pushUndo();
    set((state) => ({
      messagesByConv: {
        ...state.messagesByConv,
        [conversationId]: list.slice(0, idx + 1),
      },
    }));
    schedulePersist();
  },

  branchFrom: async (conversationId, upToMessageId, position) => {
    const { nodes, edges, messagesByConv } = get();
    const parent = nodes.find((n) => n.id === conversationId);
    if (!parent) return;
    const parentData = parent.data as Partial<ConversationData>;
    const src = messagesByConv[conversationId] ?? [];

    // 以目标 AI 回复（含）为止的全部完整状态创建分支：排除空占位，保留仅含附件无文本的消息
    const upToIdx = src.findIndex((m) => m.id === upToMessageId);
    if (upToIdx < 0) return;
    const copied = src.slice(0, upToIdx + 1).filter(
      (m) => m.content.trim() !== "" || (m.attachments?.length ?? 0) > 0
    );

    // 单次 undo 事务：节点 + 边 + 消息复制
    get().pushUndo();

    const childId = crypto.randomUUID();
    const baseTs = Date.now();
    const childMsgs = copied.map((m, i) => ({
      id: crypto.randomUUID(),
      conversationId: childId,
      role: m.role,
      content: m.content,
      attachments: m.attachments,
      refs: m.refs,
      createdAt: baseTs + i,
    }));

    const childNode = {
      id: childId,
      type: "conversation",
      position,
      // 分支节点继承默认对话尺寸（与新节点一致），用户可 resize 覆盖
      width: DEFAULT_CONVERSATION_WIDTH,
      height: DEFAULT_CONVERSATION_HEIGHT,
      data: {
        providerId: parentData.providerId ?? "",
        model: parentData.model ?? "",
        // 分支继承系统提示词（子节点独立演化，改动不影响父节点）
        systemPromptFile: parentData.systemPromptFile,
      },
    };
    // 父→子有向边仅表分支血缘：对话→对话边不进 getReferencedInputs、不生成 @chip，故无数据交互
    const childEdge = withHandles(
      {
        id: crypto.randomUUID(),
        source: conversationId,
        target: childId,
        sourceHandle: null,
        targetHandle: null,
      },
      nodes
    );

    set({
      nodes: [...nodes, childNode],
      edges: [...edges, childEdge],
      messagesByConv: { ...messagesByConv, [childId]: childMsgs },
    });

    // 文件化后 messages 嵌对话节点 data，无 FK 约束，整体随 .atlx 写（替代先落节点再 upsert 消息的两步）
    schedulePersist();
  },
  abort: (conversationId) => {
    abortControllers.get(conversationId)?.abort();
  },
  resetCanvasState: () => {
    // 删除当前画布：取消未落盘保存定时器 + 中止流，再复位全部画布态——
    // 否则残留 saveTimer 会重写已删的 .atlx、watcher 事件匹配旧 id 产生误导 reload
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    abortAllStreams();
    set({
      canvasId: null,
      canvasFile: null,
      canvasTitle: "",
      nodes: [],
      edges: [],
      readOnly: false,
      messagesByConv: {},
      streamingByConv: {},
      pendingMentionsByConv: {},
      pendingConfirmByConv: {},
      error: null,
      selectedNodeId: null,
      saving: false,
      dirty: false,
      conflictPending: false,
      baseUpdatedAt: 0,
      undoStack: [],
      redoStack: [],
    });
  },
  retrySearch: async (nodeId, query) => {
    const settings = useSettingsStore.getState();
    const data = await runSearch(settings.searchConfig, query);
    // runSearch 不抛异常（失败降级为 error 字段），直接覆盖节点 data 并落盘
    get().updateNodeData(nodeId, { ...data, query });
  },
  deleteSelected: () => {
    // 只读画布（外部白板格式）禁止删除节点
    if (get().readOnly) return;
    const { nodes, edges, onNodesChange, onEdgesChange } = get();
    const selectedNodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    // 连接后不可手动断开：Delete 只删节点，不再删除单独选中的边（连到被删节点的边随节点删除）。
    // 例外：无向关联边可单独删除（选中边后 Delete，关联线不表达数据流，无引用语义）
    const orphanEdgeIds = edges
      .filter((e) => selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target))
      .map((e) => e.id);
    const selectedUndirectedEdgeIds = edges
      .filter((e) => e.selected && e.directed === false)
      .map((e) => e.id);

    if (
      selectedNodeIds.size === 0 &&
      orphanEdgeIds.length === 0 &&
      selectedUndirectedEdgeIds.length === 0
    ) return;

    // 记录被删的对话节点 id，删除后清理其消息内存
    // （持久化层：messages 嵌对话节点，随 .atlx 整体写，删节点即删其消息）
    const deletedConvIds = nodes
      .filter((n) => selectedNodeIds.has(n.id) && n.type === "conversation")
      .map((n) => n.id);

    // 删除流式中的对话节点：先 abort（否则流无法再被中止，onDone 还会往已删节点写增量）
    if (deletedConvIds.length) {
      for (const cid of deletedConvIds) abortControllers.get(cid)?.abort();
      set((state) => {
        const next = { ...state.streamingByConv };
        for (const cid of deletedConvIds) delete next[cid];
        return { streamingByConv: next };
      });
    }

    get().pushUndo();

    const allEdgeIds = new Set([...orphanEdgeIds, ...selectedUndirectedEdgeIds]);

    if (selectedNodeIds.size > 0) {
      onNodesChange(
        [...selectedNodeIds].map((id) => ({ type: "remove" as const, id }))
      );
    }
    if (allEdgeIds.size > 0) {
      onEdgesChange(
        [...allEdgeIds].map((id) => ({ type: "remove" as const, id }))
      );
    }
    if (deletedConvIds.length) {
      set((state) => {
        const next = { ...state.messagesByConv };
        for (const id of deletedConvIds) delete next[id];
        return { messagesByConv: next };
      });
    }
  },

  // ===== Undo / Redo =====

  undo: () => {
    const state = get();
    if (state.undoStack.length === 0) return;
    // 流式期间 undo 会撕裂消息状态（占位消息不在旧快照中，后续 delta 丢失）→ 先中止流
    abortAllStreams();
    const prev = state.undoStack[state.undoStack.length - 1];
    const current = snapshot(state.nodes, state.edges, state.messagesByConv);
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      messagesByConv: prev.messagesByConv,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, current],
    });
    schedulePersist();
  },
  redo: () => {
    const state = get();
    if (state.redoStack.length === 0) return;
    abortAllStreams();
    const next = state.redoStack[state.redoStack.length - 1];
    const current = snapshot(state.nodes, state.edges, state.messagesByConv);
    set({
      nodes: next.nodes,
      edges: next.edges,
      messagesByConv: next.messagesByConv,
      undoStack: [...state.undoStack, current],
      redoStack: state.redoStack.slice(0, -1),
    });
    schedulePersist();
  },
}));


