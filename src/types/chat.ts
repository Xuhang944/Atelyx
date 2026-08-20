/**
 * AI 对话面板（右侧边栏）的消息与会话类型。
 * 持久化：会话元数据索引存 `.atelyx/editor-chats.json`，消息正文存 `.atelyx/对话历史/<会话 id>.jsonl`
 * （JSON Lines：一行一条消息记录，追加式写；单一全局历史，不按笔记归属）。
 *
 * 与画布对话（types/message.ts）的差异：面板是纯文本对话，
 * 无 attachments/refs/system 消息——错误占位用 content 的 `[错误]` 前缀标记（同 runStream 约定）。
 */
import {
  EDITOR_CHATS_SCHEMA,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
} from "@/constants/editorChats";
import type { AgentStep, ToolRun } from "./message";
import type { ReasoningEffort } from "./provider";

export {
  EDITOR_CHATS_SCHEMA,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
};

export type EditorChatRole = "user" | "assistant";

/**
 * 用户消息发送时固化的笔记引用（拖入输入框的 @引用，运行时有效）。
 * 与画布对话的 MessageRef 对称：仅「显示 @chip + 点击打开笔记」用，不参与模型上下文
 * （笔记全文注入随 user 消息 content 固化，见 chatPanelStore.send）。
 * 随消息 .jsonl 记录持久化（refs 字段），重开会话恢复 @chip。
 */
export interface EditorChatMessageRef {
  /** 被引用笔记的相对仓库根路径 */
  file: string;
  /** @chip 显示名（笔记名去 .md 后缀） */
  label: string;
}

/**
 * 笔记划词 AI 改写请求（NoteEditor 划词右键确认 → 面板输入框插入指令文本）。
 * 不改动 Agent 开关：agent 开着（勾了 edit_file）AI 直接改文件，没开则输出修改建议。
 */
export interface NoteRewriteRequest {
  /** 被划词笔记的相对仓库根路径 */
  noteFile: string;
  /** 笔记显示名（去 .md 后缀） */
  label: string;
  /** 划词选中的原文片段 */
  selectedText: string;
  /** 用户追加的评论/要求（可为空 = 仅询问/泛化改写） */
  comment: string;
}

export interface EditorChatMessage {
  /** 稳定 id：创建时生成，随 .jsonl 记录持久化，恢复不重新生成（画布/面板均需稳定 id 语义）。 */
  id: string;
  role: EditorChatRole;
  content: string;
  /**
   * Agent 步进（assistant 消息展示用，思考与工具交错，每步思考可见）。
   * 随消息 .jsonl 记录结构化持久化，重开会话恢复展示（含工具步）。
   */
  steps?: AgentStep[];
  /**
   * 模型思考过程（`delta.reasoning_content` 流式累积）。
   * 仅作气泡折叠展示，不进 API 历史上下文；遗留字段（见 `steps`），不落盘。
   */
  reasoningContent?: string;
  /**
   * user 消息气泡显示用：发送时的原始输入，与 content 分离——content 可能含注入的
   * 笔记全文（@引用）/ 系统提示词展开，气泡避免展示一大篇注入内容。
   * 随消息 .jsonl 记录持久化（displayContent 字段）。
   */
  displayContent?: string;
  /** 该 user 消息发送时拖入的笔记引用（气泡显示只读 @chip，点击打开笔记）；随 .jsonl 记录持久化。 */
  refs?: EditorChatMessageRef[];
  /** Agent 模式工具调用过程。遗留：见 `steps`（工具步随消息记录持久化）。 */
  toolRuns?: ToolRun[];
  /** 真实创建时间（发送时生成，随 .jsonl 记录持久化，恢复不重排）。 */
  createdAt: number;
}

/** 会话索引条目（editor-chats.json 的 sessions 项：只存索引，消息正文在消息 .jsonl）。 */
export interface EditorChatIndexEntry {
  id: string;
  /** 会话标题（首条 user 消息前缀，历史会话列表展示）。 */
  title?: string;
  /** 引用的 Agent 配置 id（仓库级 `.atelyx/agents.json`；发送时实时解析系统提示词/工具；缺省（未设置）= 按预置「对话」Agent 处理）。 */
  agentId?: string;
  /** 系统提示词笔记引用（遗留字段：仅兼容读取，不再注入，见 agentId）。 */
  systemPromptFile?: string;
  /** 消息正文 .jsonl 相对仓库根路径（`.atelyx/对话历史/<会话 id>.jsonl`）。 */
  file: string;
  createdAt: number;
  updatedAt: number;
}

/** 运行时会话（内存态 = 索引 + 消息正文）。 */
export interface EditorChatSession extends EditorChatIndexEntry {
  messages: EditorChatMessage[];
}

/** 面板级模型覆盖（优先于仓库默认模型；缺省 = 跟随仓库默认）。 */
export interface EditorChatModelOverride {
  providerId: string;
  model: string;
}

/** `.atelyx/editor-chats.json` 文件结构（单一全局历史：会话索引 + 全局面板状态）。 */
export interface EditorChatsFile {
  schema: typeof EDITOR_CHATS_SCHEMA;
  sessions: EditorChatIndexEntry[];
  /** 当前激活会话 id（新对话态 = null，load 不恢复）。 */
  activeSessionId: string | null;
  modelOverride: EditorChatModelOverride | null;
  /** 面板级推理等级覆盖（null = 不指定/跟随默认；与模型覆盖正交，跟随仓库默认时也可单独设置）。 */
  effortOverride: ReasoningEffort | null;
}
