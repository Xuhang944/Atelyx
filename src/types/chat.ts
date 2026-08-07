/**
 * AI 对话面板（右侧边栏）的消息与会话类型。
 * 持久化：会话元数据索引存 `.atelyx/editor-chats.json`，消息正文存 `.atelyx/对话历史/<标题>.md`
 * （单一全局历史，不按笔记归属）。
 *
 * 与画布对话（types/message.ts）的差异：面板是纯文本对话，
 * 无 attachments/refs/system 消息——错误占位用 content 的 `[错误]` 前缀标记（同 runStream 约定）。
 */
import {
  EDITOR_CHATS_SCHEMA,
  EDITOR_CHATS_SCHEMA_V1,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
} from "@/constants/editorChats";

export {
  EDITOR_CHATS_SCHEMA,
  EDITOR_CHATS_SCHEMA_V1,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
};

export type EditorChatRole = "user" | "assistant";

/**
 * 用户消息发送时固化的笔记引用（拖入输入框的 @引用，运行时有效）。
 * 与画布对话的 MessageRef 对称：仅「显示 @chip + 点击打开笔记」用，不参与模型上下文
 * （笔记全文注入随 user 消息 content 固化，见 chatPanelStore.send）。
 * 跨重启不固化——消息 .md 转写只存 displayContent（含 @标签 原文），恢复会话后 chip 降级为普通文本。
 */
export interface EditorChatMessageRef {
  /** 被引用笔记的相对仓库根路径 */
  file: string;
  /** @chip 显示名（笔记名去 .md 后缀） */
  label: string;
}

export interface EditorChatMessage {
  id: string;
  role: EditorChatRole;
  content: string;
  /**
   * 模型思考过程（`delta.reasoning_content` 流式累积）。
   * 仅作气泡折叠展示，不进 API 历史上下文；消息 .md 转写不落盘，重开后不恢复。
   */
  reasoningContent?: string;
  /**
   * user 消息气泡显示用：发送时的原始输入，与 content 分离——content 可能含注入的
   * 笔记全文（@引用）/ 系统提示词展开，气泡避免展示一大篇注入内容。
   * 消息 .md 转写存 displayContent ?? content（.md 可读的对话转写）。
   */
  displayContent?: string;
  /** 该 user 消息发送时拖入的笔记引用（气泡显示只读 @chip，点击打开笔记；仅会话运行期有效）。 */
  refs?: EditorChatMessageRef[];
  createdAt: number;
}

/** 会话索引条目（editor-chats.json 的 sessions 项：只存索引，消息正文在消息 .md）。 */
export interface EditorChatIndexEntry {
  id: string;
  /** 会话标题（首条 user 消息前缀，历史会话列表展示）。 */
  title?: string;
  /** 系统提示词笔记引用（已标记为提示词的笔记可选；缺省 = 未设置）。 */
  systemPromptFile?: string;
  /** 消息正文 .md 相对仓库根路径（`.atelyx/对话历史/<标题>.md`）。 */
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
}

/** Rust 侧读回形状：v1 存量会话可能内嵌 messages（load 迁移用）。schema 允许 v1/v2，供迁移分支判断。 */
export interface EditorChatsFileOnDisk {
  schema: typeof EDITOR_CHATS_SCHEMA | typeof EDITOR_CHATS_SCHEMA_V1;
  sessions: (EditorChatIndexEntry & { messages?: EditorChatMessage[] })[];
  activeSessionId: string | null;
  modelOverride: EditorChatModelOverride | null;
}
