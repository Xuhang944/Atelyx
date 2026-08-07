/**
 * LLM 话题自动命名：把首轮对话摘要为简短标题。
 *
 * 命名模型复用当前对话使用的 provider/model（调用方传入），不新增配置。
 * 失败/空结果返回 null——调用方保留现有占位标题，不阻塞、不重试轰炸。
 */
import { chatOnce, type ChatParams } from "@/services/ai/client";

/** 标题最大长度（中文字符，超出截断）。 */
const TITLE_MAX_LEN = 16;

/** 命名输入截断（防超长首轮对话浪费 token）。 */
const DIALOGUE_MAX_CHARS = 400;

/** 命名响应 token 上限（含思考预算）：短任务小值，防无限生成占住后端槽位。 */
const TITLE_MAX_TOKENS = 512;

/** 命名请求延迟发出时长：避开与主对话请求背靠背发送，防触发端点速率限制。 */
export const AUTO_NAMING_DELAY_MS = 3_000;

/** 最近一次自动命名的中止句柄（发送新消息前 abort，防命名请求占槽/与新消息排队）。 */
let lastTitleController: AbortController | null = null;

/** 中止进行中的自动命名请求（新消息发送前调用）。 */
export function abortAutoTitle() {
  lastTitleController?.abort();
  lastTitleController = null;
}

/** 清洗模型输出：去引号/换行/「标题：」前缀/编号，超长截断；空结果 null。 */
function cleanTitle(raw: string): string | null {
  let t = raw.trim();
  t = t.replace(/^["'「『]/u, "").replace(/["'」』]$/u, "").trim();
  t = t.replace(/^标题[:：]\s*/u, "").trim();
  // 多行输出只取首行（部分模型会追加解释）
  t = t.split("\n")[0].trim();
  // 去掉开头编号（"1. " / "1、"）
  t = t.replace(/^\d+[.、]\s*/u, "").trim();
  if (!t) return null;
  return t.slice(0, TITLE_MAX_LEN);
}

export interface AutoTitleParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

/** 用 LLM 为对话生成简短标题（失败返回 null，调用方保留占位）。 */
export async function autoTitle(
  params: AutoTitleParams,
  dialogue: string,
): Promise<string | null> {
  const excerpt = dialogue.slice(0, DIALOGUE_MAX_CHARS);
  const messages: ChatParams["messages"] = [
    {
      role: "system",
      content: `你负责为对话生成标题。只输出标题本身（不超过 ${TITLE_MAX_LEN} 字），不要引号、解释、标点或编号。`,
    },
    { role: "user", content: `为下面的对话起一个简洁的标题：\n\n${excerpt}` },
  ];
  const controller = new AbortController();
  lastTitleController = controller;
  try {
    return cleanTitle(
      await chatOnce({ ...params, messages, maxTokens: TITLE_MAX_TOKENS, signal: controller.signal })
    );
  } catch {
    return null;
  } finally {
    if (lastTitleController === controller) lastTitleController = null;
  }
}
