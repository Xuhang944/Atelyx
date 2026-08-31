/**
 * 文件类型图标 + 打开动作（协作房间 / 仓库历史 / 最近打开 / 对话 @chip / @选择器共用）。
 * 图标统一用 lucide-react 线性图标。
 */
import { FileText, Palette, Table as TableIcon } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { noteTitleFromFile } from "@/utils/filename";

export type OpenFileKind = "canvas" | "note" | "table";

/** 仓库路径 → 类型（图标显示与打开分发共用一份扩展名分类）；未知扩展名返回 null。 */
export function vaultPathKind(path: string): OpenFileKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "note";
  if (lower.endsWith(".atlx") || lower.endsWith(".canvas")) return "canvas";
  if (lower.endsWith(".atb")) return "table";
  return null;
}

/** 文件类型图标（画布/笔记/表格）。 */
export function FileKindIcon({ kind, size = 12 }: { kind: OpenFileKind; size?: number }) {
  if (kind === "canvas") return <Palette size={size} />;
  if (kind === "note") return <FileText size={size} />;
  return <TableIcon size={size} />;
}

/** 打开文件（画布需在列表命中 CanvasFileRow，笔记/表格按路径直接打开）。 */
export function openFileByKind(file: string, kind: OpenFileKind): void {
  const as = useAppStore.getState();
  if (kind === "canvas") {
    const row = as.canvases.find((c) => c.file === file);
    if (row) as.openCanvas(row);
  } else if (kind === "note") {
    as.openNote(file, noteTitleFromFile(file));
  } else {
    as.openTable(file, noteTitleFromFile(file));
  }
}

/** 按仓库路径打开任意引用目标（@chip 点击共用）：画布/笔记/表格按类型打开，
 * 其余文件与文件夹在系统文件管理器中打开（组件不直调 service，经 appStore 转发）。 */
export function openVaultPath(path: string): void {
  const kind = vaultPathKind(path);
  if (kind) return openFileByKind(path, kind);
  void useAppStore.getState().openInExplorer(path);
}
