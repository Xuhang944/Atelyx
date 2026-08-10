import { create } from "zustand";
import {
  readEditorChats,
  writeEditorChats,
  readChatMessages,
  writeChatMessages,
  deleteChatMessages,
  readNote,
} from "@/services/vault";
import { toApiMessages, type ChatParams } from "@/services/ai/client";
import { abortAutoTitle } from "@/services/ai/autoTitle";
import { runSearch } from "@/services/search";
import { WEB_SEARCH_TOOL } from "@/constants/tools";
import { runStreamExchange, decideCleanup, runAutoNaming } from "./streaming";
import { prefix, scanMentionHits } from "@/utils/text";
import { baseName } from "@/utils/filename";
import { createPersistController } from "@/utils/persist";
import { useSettingsStore } from "./settingsStore";
import { useAppStore } from "./appStore";
import {
  EDITOR_CHATS_SCHEMA,
  EDITOR_CHATS_SCHEMA_V1,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
} from "@/types";
import type {
  EditorChatMessage,
  EditorChatMessageRef,
  EditorChatModelOverride,
  EditorChatSession,
  EditorChatsFile,
  ProviderConfig,
} from "@/types";

/**
 * AI 对话面板会话状态。
 *
 * 单一全局历史：会话索引扁平存放于 `.atelyx/editor-chats.json`，消息正文存
 * `.atelyx/对话历史/<会话 id>.md`（.md 可读转写；不按笔记归属），切换笔记不切换会话；
 * 笔记上下文统一走 @引用（新会话自动 @ 当前打开笔记 / 手动拖入，发送时就地替换注入）。
 *
 * 与画布对话（canvasStore.runStream）的差异：
 * - 面板一次只流式一个会话（单输入框），无工具循环（联网搜索不做，YAGNI）
 * - 错误占位沿用 `[错误]` 前缀过滤约定
 * - provider/model 解析：`settingsStore.resolveChatTarget(modelOverride)`（面板覆盖 → 跟随仓库默认，与画布同源）
 * - 持久化 debounce 500ms：消息变化重写会话 .md，元数据变化写索引（均不在 watcher 监听范围，无自写回环）
 */

const ERROR_PREFIX = "[错误]";

interface ChatPanelState {
  sessions: EditorChatSession[];
  activeSessionId: string | null;
  /** 面板是否正在流式回复（全局单一，与当前激活会话对应）。 */
  streaming: boolean;
  /** 面板级模型覆盖（优先于仓库默认模型；null = 跟随仓库默认）。 */
  modelOverride: EditorChatModelOverride | null;
  /** 拖入输入框的笔记引用队列（文件面板拖拽笔记到 AI 对话输入框，组件消费后清空）。 */
  pendingMentions: EditorChatMessageRef[];
  /** 新对话态（无激活会话）的待用系统提示词：发送首条消息创建会话时固化进会话；新建会话/切仓库时清空，不落盘。 */
  draftSystemPromptFile: string | undefined;
  /** 面板级联网搜索工具开关（内存态：默认关、切仓库清空、不持久化；开着但搜索源未配置时发送提示并降级）。 */
  toolsEnabled: boolean;
  /** 面板内联错误提示（未配置模型/发送失败等）。 */
  error: string | null;
  loaded: boolean;
  /** 当前内存会话所属的仓库 ID（load 时记录；flush 写盘前校验归属，防跨仓库搞混）。 */
  sessionVaultId: string | null;

  /** 进仓库时加载：读盘历史会话 + 进入新对话态（默认显示新的空对话，不恢复上次激活会话）。vaultId = 当前仓库稳定 ID。 */
  load: (vaultId: string | null) => Promise<void>;
  /** 切到新对话态（activeSessionId = null，不创建空会话对象）——发送首条消息时才真正创建会话。 */
  newSession: () => void;
  /** 切换到历史会话（更新其 updatedAt 置顶排序）。 */
  openSession: (id: string) => void;
  /** 删除会话（删的是当前激活会话时回落新对话态；同时删其消息 .md）。 */
  deleteSession: (id: string) => void;
  /** 发送消息到当前激活会话（refs = 输入框内的 @引用笔记，发送时就地替换注入笔记全文）。 */
  send: (content: string, refs?: EditorChatMessageRef[]) => Promise<void>;
  /** 重新生成最后一条回复：移除最后 assistant、按 refs 重建最后一条 user 消息注入后重发（同画布 regenerate 语义）。 */
  regenerate: () => Promise<void>;
  /** 手动重新命名当前会话（按全部会话记录请求命名，立即发出无防限流延迟；失败 error 提示）。 */
  renameSession: () => Promise<void>;
  /** 回到此处：截断到指定 AI 回复（含），之后的消息移除，在此处继续对话。 */
  rollbackTo: (messageId: string) => void;
  /** 中止当前流式回复（空回复自动移除占位）。 */
  stop: () => void;
  /** 拖入的笔记引用入队（FileExplorerPanel 拖拽笔记到 AI 对话输入框时调用）。 */
  queueMention: (ref: EditorChatMessageRef) => void;
  /** 清空待消费的笔记引用队列（AiChatPanel 消费后调用）。 */
  clearPendingMentions: () => void;
  /** 设置系统提示词笔记引用（undefined = 清除）：有激活会话写会话；新对话态存 draft，发送首条消息时固化。 */
  setSystemPromptFile: (file: string | undefined) => void;
  /** 切换面板联网搜索工具开关（内存态，不持久化）。 */
  setToolsEnabled: (enabled: boolean) => void;
  /** 设置面板级模型覆盖（null = 跟随仓库默认）。 */
  setModelOverride: (ov: EditorChatModelOverride | null) => void;
  /** 清除面板内联错误。 */
  clearError: () => void;
  /** 立即落盘并返回写盘 Promise（可等待——切换仓库前必须先等旧会话写完，防写进新仓库）。
   * `vaultId` = 期望写入的仓库 ID：与内存会话所属仓库（sessionVaultId）不匹配则跳过（防跨仓库污染）。
   * 无本地改动（dirty=false）也跳过（外部删除会话文件后切仓库不写回覆盖）。 */
  flush: (vaultId: string | null) => Promise<void>;
}

let abortController: AbortController | null = null;
/** 最近一次成功 load 的仓库 ID：同一仓库重复 load（挂载 effect / selectVault / AiChatPanel vaultRoot effect）只读一次盘 */
let lastLoadedVaultId: string | null = null;
/** 会话是否有本地改动（新建/切换/删除/发送/设置变化置 true；写盘成功后清）。
 * 脏门控：未改动不写盘——外部删除会话文件后切仓库，flush 不再把内存副本写回（覆盖删除）。 */
let dirty = false;
/** 需要重写消息 .md 的会话 id 集合（发送/流式结束时标记；persistNow 统一写盘后清空）。 */
const dirtyMessageFiles = new Set<string>();

/** 防抖持久化控制器：timer 管理 + 代数防吞统一在此；extra = flush 传入的期望仓库 ID（定时写盘不传）。 */
const persistCtl = createPersistController<string | null>({
  persist: persistNow,
});

// ===== 会话消息正文转写（.atelyx/对话历史/<会话 id>.md）=====

/** 会话消息正文 .md 相对路径（文件名 = 会话 id：LLM 自动命名改标题不影响文件名，无需改名）。 */
function chatMessageFilePath(sessionId: string): string {
  return `${CHAT_HISTORY_DIR}/${sessionId}${CHAT_MESSAGE_EXT}`;
}

/**
 * 转写 .md：frontmatter 存会话 id（外部识别归属）+ `## user:` / `## assistant:` 消息段。
 * user 消息写 displayContent（原始输入），注入的笔记全文不落盘——.md 可读的对话转写。
 */
function stringifyChatMessages(sessionId: string, messages: EditorChatMessage[]): string {
  const lines = ["---", `sessionId: ${sessionId}`, "---", ""];
  for (const m of messages) {
    const text = m.role === "user" ? (m.displayContent ?? m.content) : m.content;
    lines.push(`## ${m.role}:`, "", text, "");
  }
  return lines.join("\n");
}

/**
 * 解析转写 .md → 消息（frontmatter sessionId 不匹配/结构异常返回空数组——降级不阻塞）。
 * 消息 id 每次恢复重新生成（.md 是转写而非协作增量源；画布消息才有稳定 id 需求）。
 */
function parseChatMessages(md: string, sessionId: string): EditorChatMessage[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!fm) return [];
  const sidLine = fm[1].split("\n").find((l) => l.startsWith("sessionId:"));
  if (!sidLine || sidLine.slice("sessionId:".length).trim() !== sessionId) return [];
  const body = md.slice(fm[0].length);
  // 按 `## user:` / `## assistant:` 分段（冒号可选：兼容早期无冒号写入的转写）；[pre, role, content, role, content, ...]
  const parts = body.split(/^## (user|assistant):?$/m);
  const messages: EditorChatMessage[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const role = parts[i] as EditorChatMessage["role"];
    const text = (parts[i + 1] ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
    if (!text) continue;
    messages.push({ id: crypto.randomUUID(), role, content: text, createdAt: messages.length });
  }
  return messages;
}

/** 已完成 LLM 自动命名的会话 id（一次会话只命名一次；load 切仓库时清空）。 */
const autoNamedSessions = new Set<string>();

/** 命名成功写回：登记防重复命名 + 更新索引 title + 落盘（自动命名与重新命名共用）。 */
function applySessionTitle(sessionId: string, title: string): void {
  const latest = useChatPanelStore.getState();
  if (!latest.sessions.some((x) => x.id === sessionId)) return;
  // 成功才登记：失败下轮重试；成功后消息 .md 文件名 = 会话 id，不随标题变——命名只改索引 title（随既有 debounce 写盘）
  autoNamedSessions.add(sessionId);
  useChatPanelStore.setState({
    sessions: latest.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x)),
  });
  schedulePersist();
}

/**
 * LLM 话题自动命名：一轮对话完成后为会话生成话题标题。
 * - 统一走 streaming.ts 的公共命名管线（模型解析/延迟/超时与画布共用）
 * - 失败（含被 abortAutoTitle 中止）不登记——降级保留首条消息前缀，下轮对话完成/进入仓库时自动重试
 * - 命名只改索引 title（消息 .md 文件名 = 会话 id，不随标题变）
 * - fire-and-forget：关闭/无可用模型/命名失败降级保留占位标题，不阻塞对话
 */
async function autoNameSession(sessionId: string): Promise<void> {
  await runAutoNaming({
    getMessages: () => {
      const s = useChatPanelStore.getState().sessions.find((x) => x.id === sessionId);
      return s?.messages ?? [];
    },
    isNamed: () => autoNamedSessions.has(sessionId),
    applyTitle: (title) => applySessionTitle(sessionId, title),
  });
}

/** debounce 500ms 写盘（读最新 state；`messageSessionId` = 本次改动涉及的会话，其消息 .md 需重写）。 */
function schedulePersist(messageSessionId?: string) {
  if (messageSessionId) dirtyMessageFiles.add(messageSessionId);
  dirty = true;
  persistCtl.schedule();
}

/**
 * 写盘。`guardVaultId`：切仓库前 flush 传入的「期望仓库 ID」——
 * 内存会话属于其他仓库时（sessionVaultId 不匹配）绝不写，防跨仓库污染。
 * 定时写盘不传（sessionVaultId 随 load 已同步为当前仓库）。
 */
async function persistNow(guardVaultId?: string | null): Promise<void> {
  const versionAtStart = persistCtl.version;
  // 守卫：load 完成前（loaded=false，store 仍是初始空态）不落盘——
  // React 18 StrictMode 开发模式双挂载会在 load 完成前触发卸载 flush，
  // 若此时写盘会用空 sessions 覆盖磁盘真实历史（实测：退出重进历史丢失）
  if (!useChatPanelStore.getState().loaded) return;
  // 仓库归属校验：flush 传入的期望仓库 ≠ 内存会话所属仓库 → 不写（防跨仓库搞混）
  if (
    guardVaultId !== undefined &&
    guardVaultId !== useChatPanelStore.getState().sessionVaultId
  ) {
    return;
  }
  const { sessions, activeSessionId, modelOverride } = useChatPanelStore.getState();
  // 1) 重写脏会话的消息 .md（转写）。写成功才移除——失败保留待下次 debounce/flush 重试（防消息只存在于内存而 .md 丢失）；
  //    写盘期间并发 schedulePersist 新标记的会话不在本次快照，保留由下一轮再写（防误清）。
  const pendingIds = [...dirtyMessageFiles];
  await Promise.all(
    pendingIds.map(async (id) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) {
        // 会话已删：删除路径已处理 .md，仅清标记
        dirtyMessageFiles.delete(id);
        return;
      }
      try {
        await writeChatMessages(s.file, stringifyChatMessages(s.id, s.messages));
        dirtyMessageFiles.delete(id);
      } catch (e) {
        console.error("保存会话消息失败", e);
      }
    }),
  );
  // 2) 写索引（剥离 messages：消息在 .md 转写文件）
  const index: EditorChatsFile = {
    schema: EDITOR_CHATS_SCHEMA,
    sessions: sessions.map(({ id, title, systemPromptFile, file, createdAt, updatedAt }) => ({
      id,
      title,
      systemPromptFile,
      file,
      createdAt,
      updatedAt,
    })),
    activeSessionId,
    modelOverride,
  };
  try {
    await writeEditorChats(index);
    // 写盘期间若又有新变更（schedule 已置 dirty + 挂新 timer），保留 dirty 由下一轮再写，
    // 防成功回调吞掉新编辑（消息文件已有快照保护，索引全量重写须防误清）
    if (persistCtl.version === versionAtStart) dirty = false;
  } catch (e) {
    console.error("保存 AI 对话会话失败", e);
  }
}

/**
 * 解析当前对话的 provider/model（画布/面板同源实现，见 settingsStore.resolveChatTarget）：
 * - 面板覆盖 {providerId, model} → 跟随仓库默认（默认模型反查所属供应商）
 * 覆盖供应商已删：清空失效覆盖（含持久化）并提示，本次不发送（不静默回落默认）。
 * 失败已写 error，返回 null。
 */
function resolveProviderModel(): { provider: ProviderConfig; model: string } | null {
  const ov = useChatPanelStore.getState().modelOverride;
  const resolved = useSettingsStore.getState().resolveChatTarget(ov);
  if (resolved.ok) return resolved;
  if (resolved.reason === "provider-missing") {
    // provider-missing 只可能在 ov 非空时返回（见 resolveChatTarget）；清空失效覆盖并说明已恢复跟随默认
    useChatPanelStore.getState().setModelOverride(null);
    useChatPanelStore.setState({ error: `${resolved.error}（已恢复跟随默认）` });
    return null;
  }
  useChatPanelStore.setState({ error: resolved.error });
  return null;
}

/**
 * 执行一轮流式对话（send 与 regenerate 共用）：
 * 追加 user 消息 + 空占位 assistant → SSE 流式写入（content/思考双通道 rAF 合并）→ 清理。
 * 空闲超时/错误占位/空回复移除与画布 runStream 语义一致。
 */
async function runExchange(
  active: EditorChatSession,
  userMsg: EditorChatMessage,
  provider: ProviderConfig,
  model: string,
): Promise<void> {
  const now = Date.now();
  const title = active.title ?? prefix(userMsg.displayContent ?? userMsg.content, 16);
  const asstMsg: EditorChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    createdAt: now + 1,
  };
  const updated: EditorChatSession = {
    ...active,
    title,
    messages: [...active.messages, userMsg, asstMsg],
    updatedAt: now + 1,
  };
  useChatPanelStore.setState({
    sessions: useChatPanelStore.getState().sessions.map((s) =>
      s.id === active.id ? updated : s
    ),
    streaming: true,
    error: null,
  });
  schedulePersist(active.id);

  // 系统提示词：从引用的笔记实时读正文，注入为首条 system 消息（读失败降级）
  let systemPrompt: string | undefined;
  if (updated.systemPromptFile) {
    try {
      const sysContent = await readNote(updated.systemPromptFile);
      if (sysContent.trim()) systemPrompt = sysContent;
    } catch {
      // 笔记缺失：跳过注入
    }
  }

  const controller = new AbortController();
  abortController = controller;

  // 工具开关：面板级显式开启且搜索源已配置才携带 tools；开着但未配置 → 提示并降级
  const settings = useSettingsStore.getState();
  const toolsWanted = useChatPanelStore.getState().toolsEnabled;
  const searchReady = settings.isSearchConfigured();
  if (toolsWanted && !searchReady) {
    useChatPanelStore.setState({ error: "未配置搜索源（设置 → 联网搜索），本次对话未启用联网搜索" });
  }
  const tools = toolsWanted && searchReady ? [WEB_SEARCH_TOOL] : undefined;

  // 历史含刚追加的 user 消息；过滤 [错误] 占位防污染上下文，system 提示词置首（与画布 runStream 同语义）
  const apiHistory = [...active.messages, userMsg].filter(
    (m) => !(m.role === "assistant" && m.content.startsWith(ERROR_PREFIX)),
  );

  await runStreamExchange({
    provider,
    model,
    apiMessages: [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...toApiMessages(apiHistory),
    ],
    ...(tools ? { tools } : {}),
    signal: controller.signal,
    applyBatch: ({ content, reasoning }) => {
      useChatPanelStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === active.id
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === asstMsg.id
                    ? {
                        ...m,
                        ...(content ? { content: m.content + content } : {}),
                        ...(reasoning
                          ? { reasoningContent: (m.reasoningContent ?? "") + reasoning }
                          : {}),
                      }
                    : m
                ),
              }
            : s
        ),
      }));
    },
    onError: (err) => {
      // 不静默降级：占位写入 [错误]（下次请求历史过滤，不污染上下文）
      useChatPanelStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === active.id
            ? {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === asstMsg.id
                    ? { ...m, content: m.content || `${ERROR_PREFIX} ${err.message}` }
                    : m
                ),
              }
            : s
        ),
        streaming: false,
      }));
      schedulePersist(active.id);
      void autoNameSession(active.id);
      abortController = null;
    },
    onDone: ({ content, reasoning, timedOut }) => {
      // 空回复移除占位；超时且回答未产出写超时降级（保留思考）；否则正常保留
      const decision = decideCleanup(content, reasoning, timedOut);
      useChatPanelStore.setState((state) => {
        const sess = state.sessions.find((s) => s.id === active.id);
        if (!sess) return { streaming: false };
        let messages = sess.messages;
        if (decision.kind === "timeout-error") {
          messages = messages.map((m) =>
            m.id === asstMsg.id
              ? { ...m, content: `${ERROR_PREFIX} 响应超时（长时间无输出，已自动停止）` }
              : m
          );
        } else if (decision.kind === "remove") {
          messages = messages.filter((m) => m.id !== asstMsg.id);
        }
        return {
          sessions: state.sessions.map((s) =>
            s.id === active.id ? { ...s, messages } : s
          ),
          streaming: false,
        };
      });
      schedulePersist(active.id);
      void autoNameSession(active.id);
      abortController = null;
    },
    executeTools: async (calls) => {
      // 无画布产物：仅搜索回填 tool 消息
      const toolMessages: ChatParams["messages"] = [];
      for (const tc of calls) {
        let query = "";
        try {
          query = (JSON.parse(tc.function.arguments) as { query?: string }).query ?? "";
        } catch {
          // 参数解析失败：按空 query 处理（下方失败回填）
        }
        const data = query
          ? await runSearch(useSettingsStore.getState().searchConfig, query)
          : { query: "", results: [], error: "搜索参数解析失败" };
        if (controller.signal.aborted) break;
        toolMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: data.error ? `搜索失败：${data.error}` : JSON.stringify(data.results),
        });
      }
      return toolMessages;
    },
  });
}

export const useChatPanelStore = create<ChatPanelState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streaming: false,
  modelOverride: null,
  pendingMentions: [],
  draftSystemPromptFile: undefined,
  toolsEnabled: false,
  error: null,
  loaded: false,
  sessionVaultId: null,

  load: async (vaultId) => {
    // 幂等：同一仓库已加载过则跳过（三处调用方共享，防重复读盘 + 二次 load 覆盖进行中的会话改动）
    if (useChatPanelStore.getState().loaded && lastLoadedVaultId === vaultId) {
      return;
    }
    // 清残留 debounce timer（防旧仓库 timer 写新仓库状态）+ 脏会话标记
    persistCtl.cancel();
    dirtyMessageFiles.clear();
    autoNamedSessions.clear();
    // 切仓库让路：中止旧仓库进行中的命名请求，防其后台空转/误写
    abortAutoTitle();
    set({ pendingMentions: [] });
    try {
      const f = await readEditorChats();
      const sessions: EditorChatSession[] = [];
      let migratedV1 = false;
      if (f.schema === EDITOR_CHATS_SCHEMA_V1) {
        // v1 迁移：消息内嵌 JSON → 导出消息 .md（空会话不迁移），写盘时落 v2 索引
        for (const s of f.sessions) {
          if (!s.messages || s.messages.length === 0) continue;
          const file = chatMessageFilePath(s.id);
          try {
            await writeChatMessages(file, stringifyChatMessages(s.id, s.messages));
          } catch (e) {
            console.error("迁移会话消息失败", e);
          }
          sessions.push({
            id: s.id,
            title: s.title,
            systemPromptFile: s.systemPromptFile,
            file,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messages: s.messages,
          });
        }
        migratedV1 = true;
      } else {
        // v2：读索引 + 逐个读消息 .md（读失败降级空消息，不阻塞面板）
        for (const s of f.sessions) {
          const messages = await readChatMessages(s.file)
            .then((md) => parseChatMessages(md, s.id))
            .catch(() => []);
          sessions.push({ ...s, messages });
        }
      }
      // 切仓库竞态守卫：后台填充链与 VaultSwitcher 快速切换并发时，
      // 旧仓库读取结果不得覆盖新仓库的会话（等待期间已切走则丢弃）
      if (useAppStore.getState().vaultId !== vaultId) return;
      // 新仓库干净状态：清脏标记（旧仓库未写完的改动不再写回）；v1 迁移置脏以便落 v2 索引
      dirty = migratedV1;
      lastLoadedVaultId = vaultId;
      set({
        sessions,
        // 新对话态：打开面板默认是空对话，历史会话从历史浮层手动打开；
        // 工具开关/草稿提示词为内存态，切仓库清空
        activeSessionId: null,
        sessionVaultId: vaultId,
        modelOverride: f.modelOverride,
        draftSystemPromptFile: undefined,
        toolsEnabled: false,
        loaded: true,
        error: null,
      });
      if (migratedV1) schedulePersist(); // 触发索引 v2 落盘
      // 恢复补命名：对最近使用的未命名会话重试（覆盖上次命名被中断/丢失的窗口；仅补一个防请求轰炸）。
      // 未命名判定 = title 仍为空/等于首条 user 消息前缀（命名成功会改变 title，下次 load 不再匹配）
      const unnamed = [...sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .find((s) => {
          if (autoNamedSessions.has(s.id)) return false;
          const firstUser = s.messages.find((m) => m.role === "user");
          if (!firstUser || !s.messages.some((m) => m.role === "assistant")) return false;
          return !s.title || s.title === prefix(firstUser.displayContent ?? firstUser.content, 16);
        });
      if (unnamed) void autoNameSession(unnamed.id);
    } catch (e) {
      console.error("读取 AI 对话会话失败", e);
      if (useAppStore.getState().vaultId !== vaultId) return;
      set({ loaded: true, error: "读取 AI 对话会话失败" });
    }
  },

  newSession: () => {
    // 已是新对话态（无激活会话）→ 复用；否则切到新对话态。
    // 不创建空 session 对象：空会话天然不进 sessions、不落盘、不出现在历史列表，
    // 发送首条消息时由 send 真正创建会话。draft 提示词随新建会话清空（回到全新对话态）。
    if (!get().activeSessionId) return;
    set({ activeSessionId: null, draftSystemPromptFile: undefined, error: null });
  },

  openSession: (id) => {
    if (get().activeSessionId === id) return;
    // 切换即「使用」：更新 updatedAt 让历史列表按最近使用排序
    const now = Date.now();
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, updatedAt: now } : s)),
      activeSessionId: id,
      error: null,
    });
    schedulePersist();
  },

  deleteSession: (id) => {
    const target = get().sessions.find((s) => s.id === id);
    const sessions = get().sessions.filter((s) => s.id !== id);
    dirtyMessageFiles.delete(id); // 不再重写已删会话的消息 .md
    if (target?.file) {
      // 立即删消息 .md（异步，失败仅记日志——索引已删，下次 load 不再引用）
      void deleteChatMessages(target.file).catch((e) =>
        console.error("删除会话消息文件失败", e),
      );
    }
    let activeSessionId = get().activeSessionId;
    if (activeSessionId === id) {
      // 删除当前会话 → 回落新对话态（与「默认新空对话」一致，不自动跳到其他历史）
      activeSessionId = null;
    }
    set({ sessions, activeSessionId, error: null });
    schedulePersist();
  },

  send: async (content, refs = []) => {
    const trimmed = content.trim();
    if (!trimmed || get().streaming) return;

    // 让路：中止进行中的自动命名请求（防其占用后端槽位与新消息排队）
    abortAutoTitle();

    const resolved = resolveProviderModel();
    if (!resolved) return;

    // 确保有激活会话：新对话态（null）时创建会话并激活——标题/消息 .md 路径在首条消息确定；
    // 新对话态选好的 draft 提示词随会话创建固化，随后清空
    let active: EditorChatSession | null =
      get().sessions.find((s) => s.id === get().activeSessionId) ?? null;
    if (!active) {
      const now = Date.now();
      const id = crypto.randomUUID();
      active = {
        id,
        title: prefix(trimmed, 16),
        file: chatMessageFilePath(id),
        systemPromptFile: get().draftSystemPromptFile,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      set({
        sessions: [...get().sessions, active],
        activeSessionId: active.id,
        draftSystemPromptFile: undefined,
        error: null,
      });
    }

    // @引用（自动 @ 当前笔记 / 手动拖入）：就地替换输入内的 @标签 为笔记全文（与画布对话节点 5.4 语义一致）。
    // 标签被用户手动删掉/文件缺失时跳过注入（扫描不到标签 = 该引用下沉丢弃，不记 refs）。
    let finalContent = trimmed;
    const injectedRefs: EditorChatMessageRef[] = [];
    if (refs.length) {
      const hits = scanMentionHits(
        trimmed,
        refs.map((r) => ({ nodeId: r.file, text: `@${r.label}` }))
      );
      for (let i = hits.length - 1; i >= 0; i--) {
        const { start, end, mention } = hits[i];
        const ref = refs.find((r) => r.file === mention.nodeId);
        if (!ref) continue;
        try {
          const noteText = await readNote(ref.file);
          if (noteText.trim()) {
            const name = baseName(ref.file);
            const wrapper = `[笔记《${name}》内容]\n${noteText}`;
            finalContent = finalContent.slice(0, start) + wrapper + finalContent.slice(end);
            injectedRefs.push(ref);
          }
        } catch {
          // 笔记缺失/读取失败：跳过注入（保留 @标签 原文）
        }
      }
      injectedRefs.reverse(); // 从后往前处理后恢复按 @标签 出现顺序
    }

    const userMsg: EditorChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      // 气泡显示原始输入；content 含注入的笔记全文（与画布 displayContent 分离语义一致）
      content: finalContent,
      displayContent: trimmed,
      refs: injectedRefs.length ? injectedRefs : undefined,
      createdAt: Date.now(),
    };

    await runExchange(active, userMsg, resolved.provider, resolved.model);
  },

  regenerate: async () => {
    const s = get();
    if (s.streaming) return;
    const session = s.sessions.find((x) => x.id === s.activeSessionId);
    if (!session) return;
    const list = session.messages;
    let lastUserIdx = -1;
    let lastAsstIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (lastAsstIdx < 0 && list[i].role === "assistant") lastAsstIdx = i;
      if (lastUserIdx < 0 && list[i].role === "user") lastUserIdx = i;
      if (lastUserIdx >= 0 && lastAsstIdx >= 0) break;
    }
    if (lastUserIdx < 0) return;

    const resolved = resolveProviderModel();
    if (!resolved) return;

    const userMsg = list[lastUserIdx];
    // 重建注入：refs 笔记重读全文（@标签 就地替换，同 send 语义）；displayContent 缺失/无 refs 跳过
    let rebuiltContent = userMsg.content;
    if (userMsg.displayContent && userMsg.refs?.length) {
      const hits = scanMentionHits(
        userMsg.displayContent,
        userMsg.refs.map((r) => ({ nodeId: r.file, text: `@${r.label}` }))
      );
      for (let i = hits.length - 1; i >= 0; i--) {
        const { start, end, mention } = hits[i];
        const ref = userMsg.refs.find((r) => r.file === mention.nodeId);
        if (!ref) continue;
        try {
          const noteText = await readNote(ref.file);
          if (noteText.trim()) {
            const name = baseName(ref.file);
            const wrapper = `[笔记《${name}》内容]\n${noteText}`;
            rebuiltContent = rebuiltContent.slice(0, start) + wrapper + rebuiltContent.slice(end);
          }
        } catch {
          // 笔记缺失/读取失败：跳过注入（保留 @标签 原文）
        }
      }
    }

    // 移除最后 assistant（在 user 之后）与最后 user（runExchange 重发重建版），一次 set 完成
    const asstToDrop = lastAsstIdx > lastUserIdx ? list[lastAsstIdx].id : null;
    const base = list.filter((m) => m.id !== userMsg.id && m.id !== asstToDrop);
    if (base.length !== list.length) {
      set({
        sessions: get().sessions.map((x) =>
          x.id === session.id ? { ...x, messages: base, updatedAt: Date.now() } : x
        ),
      });
      schedulePersist(session.id);
    }
    await runExchange({ ...session, messages: base }, { ...userMsg, content: rebuiltContent }, resolved.provider, resolved.model);
  },

  renameSession: async () => {
    const s = get();
    const id = s.activeSessionId;
    if (!id || s.streaming || !s.sessions.some((x) => x.id === id)) return;
    // 手动接管：中止在途的自动命名请求（防同一会话重复请求；延迟中未发出的由 isNamed 二次校验兜底跳过）
    abortAutoTitle();
    // 重新命名：全量会话记录（不截断）、立即请求（无 3s 防限流延迟——用户主动点击期待即时反馈）、
    // 不受「话题自动命名」开关限制；成功后登记防自动命名重复覆盖
    const result = await runAutoNaming(
      {
        getMessages: () => {
          const cur = useChatPanelStore.getState().sessions.find((x) => x.id === id);
          return cur?.messages ?? [];
        },
        isNamed: () => false,
        applyTitle: (title) => applySessionTitle(id, title),
      },
      { delayMs: 0, maxChars: Infinity, ignoreToggle: true },
    );
    // 反馈：真失败（请求出错）可重试；未配置模型提示配置；跳过（无消息/被中止）静默
    if (result !== "ok") {
      const hasNamingConfig = !!useSettingsStore.getState().resolveAutoNamingModel(true);
      if (!hasNamingConfig) {
        set({ error: "话题命名不可用：未配置默认模型或话题命名模型" });
      } else if (result === "failed") {
        set({ error: "话题命名失败，请稍后重试" });
      }
    }
  },

  rollbackTo: (messageId) => {
    const s = get();
    const id = s.activeSessionId;
    if (!id || s.streaming) return;
    const session = s.sessions.find((x) => x.id === id);
    if (!session) return;
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx < 0 || idx === session.messages.length - 1) return;
    set({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, messages: session.messages.slice(0, idx + 1), updatedAt: Date.now() }
          : x
      ),
    });
    schedulePersist(id);
  },

  stop: () => {
    abortController?.abort();
  },

  setSystemPromptFile: (file) => {
    const id = get().activeSessionId;
    if (id) {
      set({
        sessions: get().sessions.map((s) =>
          s.id === id ? { ...s, systemPromptFile: file } : s
        ),
      });
      schedulePersist();
    } else {
      // 新对话态：暂存待用，发送首条消息创建会话时固化（见 send）
      set({ draftSystemPromptFile: file });
    }
  },

  setToolsEnabled: (enabled) => set({ toolsEnabled: enabled }),

  setModelOverride: (ov) => {
    set({ modelOverride: ov });
    schedulePersist();
  },

  clearError: () => set({ error: null }),

  queueMention: (ref) => {
    set((state) => ({
      pendingMentions: state.pendingMentions.some((r) => r.file === ref.file)
        ? state.pendingMentions
        : [...state.pendingMentions, ref],
    }));
  },

  clearPendingMentions: () => set({ pendingMentions: [] }),

  flush: (vaultId) => {
    // 无本地改动不写盘：外部删除会话文件后切仓库/退出，不把内存副本写回（覆盖删除）
    if (!dirty) return Promise.resolve();
    return persistCtl.flush(vaultId);
  },
}));
