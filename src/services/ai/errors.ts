/**
 * AI 请求错误：结构化错误码 + 分类纯函数。
 *
 * - `LlmError`：带稳定 `code`（机器可路由，不靠解析 message 字符串），可选 `status`/`retryAfterMs`。
 * - `classifyMessage` / `toLlmError`：从 HTTP 状态 / 错误文本综合归类出稳定 `code`（含 retryable 判定）。
 *   合并了原错误分类的 `isRetryableError`/`isContextOverflow` 判定，并增强
 *   对 context-window / quota 的识别（quota/auth 快速失败，transport/5xx/429 重试）。
 *
 * 分类规则只在这一个文件维护，client / streaming / 调用方共用。
 */
import type { LlmErrorCode } from "@/types";

/** 上下文溢出错误的友好提示（追加到原始错误消息后展示）。 */
export const OVERFLOW_HINT = "上下文过长：建议精简对话、去掉多余引用，或新建分支继续";

/** 结构化 AI 错误（稳定 code 路由，不再靠字符串正则猜测）。 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    code: LlmErrorCode,
    opts?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.status = opts?.status;
    this.retryAfterMs = opts?.retryAfterMs;
    this.name = "LlmError";
  }
}

/** 可重试的传输级失败特征（网络抖动 / 限流 / 服务端临时故障）。 */
const RETRYABLE_PATTERNS = [
  /overloaded/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /temporarily\s*unavailable/i,
  /service\s*unavailable/i,
  /connection\s*refused/i,
  /fetch\s*failed/i,
  /enotfound|eai_again|econnreset|econnrefused|socket\s*hang\s*up/i,
  /stream\s*ended\s*before/i,
  /http2\s*request\s*did\s*not\s*get\s*a\s*response/i,
];

/** 快速失败（不重试）的鉴权 / 配额特征。 */
const NON_RETRYABLE_PATTERNS = [
  /quota|insufficient_quota|out\s*of\s*budget|billing/i,
  /invalid\s*(api\s*)?key|unauthorized|unauthorised|forbidden/i,
];

/** 上下文溢出特征（请求超过模型 context window）。 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt\s+is\s+too\s+long/i,
  /context\s+length\s+exceeded/i,
  /exceed(s|ed)?\s+the\s+(model\s*'?s\s*)?context\s+window/i,
  /maximum\s+context\s+length/i,
  /context\s+too\s+large/i,
  /reduce\s+the\s+length\s+of\s+the\s+messages/i,
];

/** 账号配额/余额耗尽特征（终态，区别于瞬时限流）。 */
const QUOTA_PATTERNS = [
  /insufficient[\s_-]+(?:quota|balance|credits?)/i,
  /quota[\s_-]+(?:exceeded|exhausted|reached)|usage[\s_-]+limit[\s_-]+(?:exceeded|reached)/i,
  /(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/i,
  /out\s*of\s*(?:credits?|budget)/i,
];

function matchStatus(msg: string): number | null {
  const m = msg.match(/HTTP\s+(\d{3})/);
  return m ? Number(m[1]) : null;
}

/** 根据错误文本判定错误码（正文优先，其次 HTTP 状态兜底）。 */
export function classifyMessage(text: string): LlmErrorCode {
  if (CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text))) return "CONTEXT_OVERFLOW";
  if (QUOTA_PATTERNS.some((re) => re.test(text))) return "QUOTA";
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(text))) return "AUTH";
  if (RETRYABLE_PATTERNS.some((re) => re.test(text))) return "TRANSPORT";
  const status = matchStatus(text);
  if (status !== null) {
    if (status === 429 || status >= 500) return "TRANSPORT";
    if (status === 401 || status === 403) return "AUTH";
    if (status === 400) return "BAD_REQUEST";
    return "HTTP";
  }
  return "UNKNOWN";
}

/** 该错误是否可重试（传输级 / 5xx / 429；quota/auth/其余快速失败）。 */
export function isRetryableError(err: Error): boolean {
  if (err instanceof LlmError) {
    return err.code === "TRANSPORT";
  }
  return classifyMessage(err.message) === "TRANSPORT";
}

/** 该错误是否表示上下文溢出（超长请求不再裸报错，降级为友好提示）。 */
export function isContextOverflow(err: Error): boolean {
  if (err instanceof LlmError) return err.code === "CONTEXT_OVERFLOW";
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(err.message));
}

/**
 * 上下文溢出错误追加友好提示（防用户看到裸 API 报错不知所措）。
 * 已带 code 的 LlmError 直接补文案，不双重包装。
 */
export function withOverflowHint(err: Error): Error {
  if (isContextOverflow(err)) {
    return new Error(`${err.message}（${OVERFLOW_HINT}）`);
  }
  return err;
}

/**
 * 从 HTTP 状态 / 错误文本 / retry-after 组装 LlmError。
 * 传输级失败携带 `retryAfterMs`（供 retry 策略）；配额/鉴权快速失败。
 */
export function toLlmError(
  message: string,
  opts?: { status?: number; retryAfterMs?: number; cause?: unknown },
): LlmError {
  const code = classifyMessage(message);
  return new LlmError(message, code, {
    status: opts?.status,
    retryAfterMs: opts?.retryAfterMs,
    cause: opts?.cause,
  });
}
