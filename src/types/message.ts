/**
 * 对话消息类型，对应 DB messages 表。
 * role 遵循 OpenAI 兼容协议。
 */
export type Role = "system" | "user" | "assistant";

export interface Attachment {
  kind: "image" | "file";
  /** 图片：base64 data URL；文件：解析出的文本内容 */
  payload: string;
  mime: string;
  filename?: string;
  /** 来自画布媒体节点（@ 提及 / 连边）时标记源节点 id（用于「已注入」检测），临时附件无此字段 */
  sourceNodeId?: string;
}

/**
 * user 消息发送时固化的文本/搜索引用记录（一次性注入语义）。
 * 与 attachments 的固化语义对称：注入随该 user 消息进历史，未来消息不重复注入。
 */
export interface MessageRef {
  /** 源文本/搜索节点 id（消息气泡 @chip 点击定位目标） */
  nodeId: string;
  /** @chip 显示名（内容前缀约 12 字） */
  label: string;
}

/**
 * 对话输入框的待发送附件（临时附件通道）。
 * 生命周期：进托盘 → 随 user 消息发送（转为 Attachment 持久化）→ 无源附件生成影子节点。
 */
export interface PendingAttachment {
  id: string;
  kind: "image" | "file";
  /** 图片：data URL；文件：读取的文本内容（解析失败为空字符串） */
  payload: string;
  mime: string;
  filename?: string;
  /** 来自画布媒体节点（@ 提及 / 连边）时标记源节点 id（用于「已注入」检测），临时附件无此字段 */
  sourceNodeId?: string;
  /** 文本类文件解析失败，仅作画布参考 */
  parseFailed?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  /**
   * 模型思考过程（`delta.reasoning_content` 流式累积，思考型模型的推理阶段内容）。
   * 仅作气泡折叠展示，不进 API 历史上下文。
   */
  reasoningContent?: string;
  /**
   * user 消息气泡显示用：发送时的原始输入（含 @提及 标记），与 content 分离——
   * content 是 @提及 就地替换后的展开版（发给模型/历史重发），气泡避免展示一大篇正文。
   */
  displayContent?: string;
  /** user 消息可携带多模态附件（图片走 vision） */
  attachments?: Attachment[];
  /**
   * 该 user 消息发送时一次性注入的文本/搜索引用（固化进消息，未来不重复注入）。
   * 用于消息气泡显示只读 @chip + 点击定位到源节点。
   */
  refs?: MessageRef[];
  createdAt: number;
}
