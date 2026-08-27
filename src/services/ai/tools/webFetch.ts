/**
 * 工具：抓取网页（web_fetch）。抓取指定 URL 的正文回填上下文，作为回答依据。不建画布产物节点。
 * 依赖 `capabilities.fetchUrl`（后端代理，规避浏览器 CORS）。
 */
import { ToolArgsError, errText } from "@/types";
import { defineTool } from "./defineTool";

export interface WebFetchArgs {
  url: string;
}

export const WEB_FETCH_TOOL = defineTool<WebFetchArgs>({
  name: "web_fetch",
  parallelSafe: true,
  description: "抓取指定网页（URL）的正文内容，获取最新信息作为回答依据",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "要抓取的网页完整 URL（https 开头）" } },
    required: ["url"],
  },
  validate: (args) => {
    const u = (args as { url?: unknown } | undefined)?.url;
    if (typeof u !== "string" || !/^https?:\/\//i.test(u.trim())) {
      throw new ToolArgsError("缺少合法的网页地址 url（需 https:// 开头）");
    }
    return { url: u.trim() };
  },
  summarize: (args) => {
    const u = args.url?.trim();
    return u ? `抓取 ${u.slice(0, 48)}` : "抓取网页";
  },
  execute: async (args, exec) => {
    const cap = exec.capabilities.fetchUrl;
    if (!cap) return { ok: false, summary: "抓取网页能力未启用" };
    try {
      const r = await cap(args.url);
      if (!r.content) return { ok: false, summary: "抓取成功但无正文内容" };
      const summary = `已抓取 ${r.title || args.url}`;
      return { ok: true, summary, content: r.content };
    } catch (e) {
      return { ok: false, summary: `抓取失败：${errText(e)}` };
    }
  },
});
