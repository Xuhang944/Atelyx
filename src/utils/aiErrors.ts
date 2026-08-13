/**
 * AI 请求错误分类纯函数（通用 agent 工程实践精简移植）。
 * - `isRetryableError`：传输级可重试判定（网络抖动/5xx/限流）——可重试错误由客户端退避重试，
 *   配额/鉴权类失败快速失败不折腾。
 * - `isContextOverflow`：上下文溢出判定——超长请求不再裸报错，降级为友好提示。
 * 分类规则只在这一个文件维护，client/streaming 共用。
 */

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

const NON_RETRYABLE_PATTERNS = [
  /quota|insufficient_quota|out\s*of\s*budget|billing/i,
  /invalid\s*(api\s*)?key|unauthorized|forbidden/i,
];

/** 错误消息是否属于可重试的传输级失败（网络/限流/服务端临时故障）。 */
export function isRetryableError(err: Error): boolean {
  const msg = err.message;
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))) return false;
  if (RETRYABLE_PATTERNS.some((re) => re.test(msg))) return true;
  // HTTP 状态码兜底：429/5xx 可重试
  const m = msg.match(/HTTP\s+(\d{3})/);
  if (m) {
    const status = Number(m[1]);
    return status === 429 || status >= 500;
  }
  return false;
}

const OVERFLOW_PATTERNS = [
  /prompt\s+is\s+too\s+long/i,
  /context\s+length\s+exceeded/i,
  /exceed(s|ed)?\s+the\s+(model\s*'?s\s*)?context\s+window/i,
  /maximum\s+context\s+length/i,
  /context\s+too\s+large/i,
  /reduce\s+the\s+length\s+of\s+the\s+messages/i,
];

/** 错误消息是否表示上下文溢出（请求超过模型 context window）。 */
export function isContextOverflow(err: Error): boolean {
  return OVERFLOW_PATTERNS.some((re) => re.test(err.message));
}

/** 溢出错误的友好提示（追加到原始错误消息后展示）。 */
export const OVERFLOW_HINT = "上下文过长：建议精简对话、去掉多余引用，或新建分支继续";
