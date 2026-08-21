/**
 * 视图承载（主窗口面积与撕裂窗口共用）：按视图类型分派渲染 + 头部状态指示。
 *
 * hostId = 面积 id 或撕裂窗口 id（画布/表格聚焦门控用）。各视图内容由全局 store
 * 驱动（画布/表格/笔记打开文件状态），本组件只做分派；`ViewStatusIndicator` 供
 * 面积头/撕裂窗口头渲染保存/冲突/错误状态。
 */
import {
  FileText,
  Files,
  Info,
  LayoutTemplate,
  Palette,
  Search,
  Sparkles,
  Table as TableIcon,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { useTableStore } from "@/stores/tableStore";
import { useVaultStore } from "@/stores/vaultStore";
import { CanvasView } from "@/components/layout/views/CanvasView";
import { NoteView } from "@/components/layout/views/NoteView";
import { TableView } from "@/components/layout/views/TableView";
import { FilesView } from "@/components/layout/views/FilesView";
import { SearchView } from "@/components/layout/views/SearchView";
import { InspectorView } from "@/components/layout/views/InspectorView";
import { AiChatView } from "@/components/layout/views/AiChatView";
import type { ViewKind } from "@/types";

/** 视图元信息（标签/头部共用）。 */
export const VIEW_META: Record<ViewKind, { label: string; icon: ReactNode }> = {
  canvas: { label: "画布", icon: <Palette size={13} /> },
  note: { label: "笔记", icon: <FileText size={13} /> },
  table: { label: "表格", icon: <TableIcon size={13} /> },
  files: { label: "文件", icon: <Files size={13} /> },
  search: { label: "搜索", icon: <Search size={13} /> },
  inspector: { label: "属性", icon: <Info size={13} /> },
  aichat: { label: "AI 对话", icon: <Sparkles size={13} /> },
  empty: { label: "空面积", icon: <LayoutTemplate size={13} /> },
};

/** 按视图类型分派渲染（空视图 = 占位引导）。 */
export function ViewHost({ view, hostId }: { view: ViewKind; hostId: string }) {
  switch (view) {
    case "canvas":
      return <CanvasView areaId={hostId} />;
    case "note":
      return <NoteView />;
    case "table":
      return <TableView areaId={hostId} />;
    case "files":
      return <FilesView />;
    case "search":
      return <SearchView />;
    case "inspector":
      return <InspectorView />;
    case "aichat":
      return <AiChatView />;
    default:
      // 空面积：不渲染占位提示（右键头部/内容区可添加视图，≡ 菜单可分割/删除面积）
      return <div className="h-full w-full" style={{ background: "var(--bg-primary)" }} />;
  }
}

/** 画布视图状态指示（无当前画布不显示；冲突 > 错误 > 保存状态）。 */
function CanvasStatusIndicator() {
  const canvasId = useCanvasStore((s) => s.canvasId);
  const canvasFile = useAppStore((s) => s.currentCanvasFile);
  const loading = useCanvasStore((s) => s.loading);
  const saving = useCanvasStore((s) => s.saving);
  const readOnly = useCanvasStore((s) => s.readOnly);
  const conflictPending = useCanvasStore((s) => s.conflictPending);
  const mergeFromDisk = useCanvasStore((s) => s.mergeFromDisk);
  const reloadFromDisk = useCanvasStore((s) => s.reloadFromDisk);
  const error = useCanvasStore((s) => s.error);
  const clearError = useCanvasStore((s) => s.clearError);
  const load = useCanvasStore((s) => s.load);
  if (!canvasId) return null;
  if (conflictPending) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
      >
        <span className="truncate max-w-[150px]">画布与外部修改冲突</span>
        <button
          onClick={() => void mergeFromDisk()}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="以磁盘为基底保留本地新增内容（重叠以磁盘为准）"
        >
          合并
        </button>
        <button
          onClick={() => void reloadFromDisk()}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="丢弃本地改动，加载磁盘最新内容"
        >
          重载
        </button>
      </span>
    );
  }
  if (error) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}
      >
        <span className="truncate max-w-[160px]">{error}</span>
        {error === "加载画布失败，请重试" && canvasFile && (
          <button
            onClick={() => void load(canvasFile)}
            className="px-1 rounded hover:opacity-80"
            style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
          >
            重试
          </button>
        )}
        <button
          onClick={() => clearError()}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
          aria-label="关闭错误提示"
        >
          <X size={12} />
        </button>
      </span>
    );
  }
  return (
    <span className="flex-shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
      {loading ? "加载中…" : saving ? "保存中…" : readOnly ? "只读（外部白板格式）" : "已自动保存"}
    </span>
  );
}

/** 表格视图状态指示（无当前表格不显示；冲突 > 错误 > 保存状态）。 */
function TableStatusIndicator() {
  const currentTableFile = useAppStore((s) => s.currentTableFile);
  const saving = useTableStore((s) => s.saving);
  const conflictPending = useTableStore((s) => s.conflictPending);
  const resolveConflict = useTableStore((s) => s.resolveConflict);
  const error = useTableStore((s) => s.error);
  const clearError = useTableStore((s) => s.clearError);
  if (!currentTableFile) return null;
  if (conflictPending) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
      >
        <span className="truncate max-w-[150px]">表格与外部修改冲突</span>
        <button
          onClick={() => void resolveConflict(false)}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="丢弃本地改动，加载磁盘最新内容"
        >
          重新加载
        </button>
        <button
          onClick={() => void resolveConflict(true)}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="用本地内容覆盖磁盘（外部改动丢失）"
        >
          保留本地
        </button>
      </span>
    );
  }
  if (error) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}
      >
        <span className="truncate max-w-[160px]">{error}</span>
        <button
          onClick={() => clearError()}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
          aria-label="关闭错误提示"
        >
          <X size={12} />
        </button>
      </span>
    );
  }
  return (
    <span className="flex-shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
      {saving ? "保存中…" : "已自动保存"}
    </span>
  );
}

/** 笔记视图状态指示（无当前笔记不显示；冲突 > 保存状态）。 */
function NoteStatusIndicator() {
  const currentNoteFile = useAppStore((s) => s.currentNoteFile);
  const conflict = useVaultStore((s) => (currentNoteFile ? s.noteConflicts[currentNoteFile] : false));
  const status = useVaultStore((s) => (currentNoteFile ? s.noteSaveStates[currentNoteFile] : undefined));
  const resolveNoteConflict = useVaultStore((s) => s.resolveNoteConflict);
  if (!currentNoteFile) return null;
  if (conflict) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
      >
        <span className="truncate max-w-[150px]">外部已修改此文件</span>
        <button
          onClick={() => resolveNoteConflict(currentNoteFile, false)}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="丢弃本地改动，加载外部最新内容"
        >
          重新加载
        </button>
        <button
          onClick={() => resolveNoteConflict(currentNoteFile, true)}
          className="px-1 rounded hover:opacity-80"
          style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
          title="用本地内容覆盖外部修改并立即保存"
        >
          保留本地
        </button>
      </span>
    );
  }
  if (!status) return null;
  const text = status.loadError
    ? "读取失败"
    : status.state === "saving"
      ? "保存中…"
      : status.state === "error"
        ? "保存失败"
        : status.state === "edited"
          ? "未保存"
          : status.state === "saved"
            ? "已自动保存"
            : null;
  if (!text) return null;
  return (
    <span
      className="flex-shrink-0 text-xs"
      style={{ color: status.loadError || status.state === "error" ? "#f87171" : "var(--text-muted)" }}
    >
      {text}
    </span>
  );
}

/** 按视图类型分派状态指示（view 变化 = 子组件类型切换，各子组件 hooks 固定）。 */
export function ViewStatusIndicator({ view }: { view: ViewKind }) {
  switch (view) {
    case "canvas":
      return <CanvasStatusIndicator />;
    case "table":
      return <TableStatusIndicator />;
    case "note":
      return <NoteStatusIndicator />;
    default:
      return null;
  }
}
