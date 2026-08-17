/**
 * 提供者中立的 LLM 词汇。
 *
 * 适配器负责「中性词汇 ⇄ 供应商线上格式」的翻译；引擎/调用方只接触中性类型，
 * 不感知具体供应商线协议。当前仅一个 OpenAI 兼容适配器，未来加供应商 = 再加一个
 * 实现同一接缝的适配器。类型刻意收敛到我们 UI 所需（文本 + 思考），不引入完整
 * content-block 数组，避免过度抽象。
 */
import type { ToolSchema } from "./tool";

export type LlmRole = "system" | "user" | "assistant" | "tool";

/** 一次工具调用（中性的 function-call 描述）。 */
export interface LlmToolCall {
  id: string;
  name: string;
  /** 模型产出的原始参数 JSON 串。 */
  arguments: string;
}

/** 单条令牌计量（缓存字段可选；`inputTokens` 为未缓存输入）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 用户消息的多模态部分（适配器折成 content parts：text / image）。 */
type UserParts = {
  /** 图片附件：data URL（vision）。 */
  images?: { url: string }[];
  /** 文件附件解析出的文本片段（与正文并列注入）。 */
  fileTexts?: string[];
};

/** 除 user 外的消息（system/assistant/tool）体。 */
type PlainLlmMessage = {
  role: "system" | "assistant" | "tool";
  text: string | null;
  /** 模型思考过程（仅 assistant 携带；不进上下文，仅展示）。 */
  reasoning?: string;
  /** assistant 带工具调用时 text 为 null（OpenAI 规范）。 */
  toolCalls?: LlmToolCall[];
  /** tool 消息回填时指向对应调用的 id。 */
  toolCallId?: string;
};

/** user 消息体（可带多模态附件）。 */
type UserLlmMessage = {
  role: "user";
  text: string;
} & UserParts;

/** 提供者中立的对话消息。 */
export type LlmMessage = PlainLlmMessage | UserLlmMessage;

/** 模型为何停止（收敛到我们需要的子集）。 */
export type LlmFinishReason =
  | "stop"
  | "tool-calls"
  | "max-tokens"
  | "aborted"
  | "error";

/** 结构化错误码（稳定、可机器路由，不靠解析 message 字符串）。 */
export type LlmErrorCode =
  | "TRANSPORT"
  | "HTTP"
  | "CONTEXT_OVERFLOW"
  | "QUOTA"
  | "AUTH"
  | "BAD_REQUEST"
  | "EMPTY_RESPONSE"
  | "TIMEOUT"
  | "UNKNOWN";

/** 适配器原始流事件。tool-call 在参数累积完整后一次性发出。 */
export type LlmStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: LlmToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: LlmFinishReason };

/** 单次模型请求（去掉 provider 路由——当前直连单适配器）。 */
export interface LlmRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  /** 系统提示词（适配器映射到供应商 system 槽）。 */
  system?: string;
  /** 工具名册（适配器映射到供应商 tools 字段）。 */
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

