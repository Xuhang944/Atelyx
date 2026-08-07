/**
 * 系统 shell service（在文件管理器中打开路径 / 默认程序打开 URL 等）。
 */
import { open as shellOpen } from "@tauri-apps/plugin-shell";

/** 在系统文件管理器中打开路径（目录或文件，选中态）。 */
export async function openInExplorer(path: string): Promise<void> {
  await shellOpen(path);
}

/** 用系统默认程序打开外部 URL（http/https/mailto 等；webview 不导航）。 */
export async function openUrl(url: string): Promise<void> {
  await shellOpen(url);
}
