/**
 * 系统对话框 service（目录/文件选择器）。
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/** 调系统目录选择器，用户取消返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

/** 调系统文件选择器（单选，可过滤扩展名），用户取消返回 null。 */
export async function pickFile(
  filters?: { name: string; extensions: string[] }[]
): Promise<string | null> {
  const picked = await openDialog({ multiple: false, filters });
  return typeof picked === "string" ? picked : null;
}
