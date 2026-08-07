/**
 * AI 对话工具定义（OpenAI 兼容 function calling）。
 * 画布对话节点与 AI 对话面板共用；发送前由调用方按「工具开关 + 搜索源已配置」决定是否携带。
 */
import type { ToolDef } from "@/services/ai/client";

/** 联网搜索工具：AI 自主决定搜索，结果回填上下文。 */
export const WEB_SEARCH_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网搜索获取最新信息，返回网页标题、摘要与链接（可作为回答依据）",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
  },
};
