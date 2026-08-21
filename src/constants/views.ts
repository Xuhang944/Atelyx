/**
 * 视图显示名（面积头标签 / 撕裂窗口标题共用）。
 */
import type { ViewKind } from "@/types";

export const VIEW_LABELS: Record<ViewKind, string> = {
  canvas: "画布",
  note: "笔记",
  table: "表格",
  files: "文件",
  search: "搜索",
  inspector: "属性",
  aichat: "AI 对话",
  empty: "空面积",
};
