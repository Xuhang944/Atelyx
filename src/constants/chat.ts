/**
 * AI 对话共享常量（画布对话节点 / AI 对话面板共用，单一维护点）。
 */

/** 错误占位前缀：写入消息 content 并随画布/会话持久化；发送前按此前缀过滤，防污染 API 历史。 */
export const ERROR_PREFIX = "[错误]";

/** 流式空闲超时的友好降级文案（超时且回答未产出时写入占位，拼接在 ERROR_PREFIX 后）。 */
export const TIMEOUT_ERROR_TEXT = "响应超时（长时间无输出，已自动停止）";

/** 回复被截断（达到输出上限）的友好降级文案（有正文则拼在其后，正文为空则拼在 ERROR_PREFIX 后作占位）。 */
export const TRUNCATED_TEXT = "回复被截断（达到输出上限，已保留已生成内容）";
