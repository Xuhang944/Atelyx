/**
 * 网页抓取 service（AI `fetch_url` 工具的产物数据源）。
 * 抓取统一走 Tauri Rust 代理（`fetch_web` 命令）——浏览器/WebView 前端直 fetch 受 CORS 拦截，
 * 且便于统一超时与大小上限。返回 title + 正文纯文本。
 * 边界捕获：失败返回 error 字段，不抛异常（失败降级不阻塞对话）。
 */
import { invoke } from "@tauri-apps/api/core";

export interface FetchedWebPage {
  url: string;
  title?: string;
  content: string;
  /** 正文是否命中大小上限被截断（工具据此提示内容不完整）。 */
  truncated?: boolean;
}

/**
 * 抓取网页正文（Rust 代理）。边界捕获：失败抛出，由调用方（工具 execute）降级为失败结果。
 */
export async function fetchWeb(url: string): Promise<FetchedWebPage> {
  return invoke<FetchedWebPage>("fetch_web", { url });
}
