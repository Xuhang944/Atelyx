/**
 * 文件类型图标 + 显示标题 + 打开动作（主页面板共用：协作房间 / 仓库历史 / 最近打开）。
 * 图标统一用 lucide-react 线性图标；标题 = 路径末段文件名去扩展名。
 */
import { FileText, Palette, Table as TableIcon } from "lucide-react";
import { useAppStore } from "@/stores/appStore";

export type OpenFileKind = "canvas" | "note" | "table";

/** 显示标题：路径末段文件名去最后一个扩展名。 */
export function fileTitle(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
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
    as.openNote(file, fileTitle(file));
  } else {
    as.openTable(file, fileTitle(file));
  }
}

