/**
 * 面积框：header（视图切换 + 关闭）+ 视图分派。
 *
 * - 视图切换：左上角按钮弹出视图选择器（已占用类型禁用——每种视图最多一个面积）
 * - 关闭：✕ = 合并到相邻面积（最后一个面积不可关闭，按钮隐藏）
 * - 文件打开不走面积 header（文件面板/搜索面板单击即打开到对应视图面积）
 * - 聚焦：点击面积任意处聚焦（画布快捷键门控依据）
 */
import { ChevronDown, FileText, Files, Info, LayoutTemplate, Palette, Search, Sparkles, Table as TableIcon, X } from "lucide-react";
import { memo, useRef, type ReactNode } from "react";
import { useUiStateStore } from "@/stores/uiStateStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useTableStore } from "@/stores/tableStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useAppStore } from "@/stores/appStore";
import { usePopupAnchor } from "@/hooks/usePopupAnchor";
import { PopupLayer } from "@/components/common/PopupLayer";
import { AreaPlaceholder } from "@/components/layout/AreaPlaceholder";
import { CanvasView } from "@/components/layout/views/CanvasView";
import { noteTitleFromFile, tableTitleFromFile } from "@/utils/filename";
import { NoteView } from "@/components/layout/views/NoteView";
import { TableView } from "@/components/layout/views/TableView";
import { FilesView } from "@/components/layout/views/FilesView";
import { SearchView } from "@/components/layout/views/SearchView";
import { InspectorView } from "@/components/layout/views/InspectorView";
import { AiChatView } from "@/components/layout/views/AiChatView";
import { VIEW_KINDS, type AreaNode, type ViewKind } from "@/types";

const VIEW_META: Record<ViewKind, { label: string; icon: ReactNode }> = {
  canvas: { label: "画布", icon: <Palette size={13} /> },
  note: { label: "笔记", icon: <FileText size={13} /> },
  table: { label: "表格", icon: <TableIcon size={13} /> },
  files: { label: "文件", icon: <Files size={13} /> },
  search: { label: "搜索", icon: <Search size={13} /> },
  inspector: { label: "属性", icon: <Info size={13} /> },
  aichat: { label: "AI 对话", icon: <Sparkles size={13} /> },
  empty: { label: "空面积", icon: <LayoutTemplate size={13} /> },
};

/** 画布面积 header 状态指示（无当前画布不显示；冲突 > 错误 > 保存状态）。 */
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

/** 表格面积 header 状态指示（无当前表格不显示；冲突 > 错误 > 保存状态）。 */
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

/** 笔记面积 header 状态指示（无当前笔记不显示；冲突 > 保存状态）。 */
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
function AreaStatusIndicator({ view }: { view: ViewKind }) {
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

export const AreaFrame = memo(function AreaFrame({
  node,
  onFocus,
  usedKey,
  areaCount,
}: {
  node: AreaNode;
  onFocus: (id: string) => void;
  /** 已占用视图集合的稳定键（WorkspaceGrid 计算；resize 时不变，memo 跳过重渲染）。 */
  usedKey: string;
  /** 当前布局面积总数（= 1 时不可关闭，隐藏 ✕）。 */
  areaCount: number;
}) {
  const setAreaView = useUiStateStore((s) => s.setAreaView);
  const closeArea = useUiStateStore((s) => s.closeArea);

  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const picker = usePopupAnchor(pickerTriggerRef);

  const used = new Set(usedKey ? usedKey.split(",") : []);

  const meta = VIEW_META[node.view];

  // 画布/笔记/表格打开文件时，视图切换按钮直接显示文件名（其余视图/无文件为 null）
  const currentFile = useAppStore((s) =>
    node.view === "canvas"
      ? s.currentCanvasFile
      : node.view === "note"
        ? s.currentNoteFile
        : node.view === "table"
          ? s.currentTableFile
          : null,
  );
  const fileTitle = currentFile
    ? node.view === "table"
      ? tableTitleFromFile(currentFile)
      : noteTitleFromFile(currentFile)
    : null;

  const renderView = () => {
    switch (node.view) {
      case "canvas":
        return <CanvasView areaId={node.id} />;
      case "note":
        return <NoteView />;
      case "table":
        return <TableView areaId={node.id} />;
      case "files":
        return <FilesView />;
      case "search":
        return <SearchView />;
      case "inspector":
        return <InspectorView />;
      case "aichat":
        return <AiChatView />;
      default:
        return (
          <AreaPlaceholder
            icon={<LayoutTemplate size={64} strokeWidth={1.5} />}
            title="空面积"
            description="从左上角菜单选择此面积要承载的视图（画布 / 笔记 / 表格 / 文件 / 搜索 / 属性 / AI 对话）。"
          />
        );
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0" onClick={() => onFocus(node.id)}>
      {/* 面积 header */}
      <div
        className="h-7 flex items-center gap-1 px-1.5 border-b flex-shrink-0 select-none"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      >
        <div className="flex-shrink-0">
          <button
            ref={pickerTriggerRef}
            onClick={(e) => {
              e.stopPropagation();
              picker.toggle();
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: "var(--text-secondary)" }}
            title={currentFile ?? "切换视图类型"}
          >
            {meta.icon}
            <span
              className="max-w-[200px] truncate text-xs"
              style={{ color: fileTitle ? "var(--accent)" : "var(--text-primary)" }}
            >
              {fileTitle ?? meta.label}
            </span>
            <ChevronDown size={11} />
          </button>
          {/* 统一弹层（PopupLayer）：锚定按钮实测位置 + 视口钳制/翻转 + Esc/外点关闭 */}
          <PopupLayer
            anchor={picker.anchor}
            onClose={picker.close}
            triggerRef={pickerTriggerRef}
            widthClass="w-36"
            repositionDeps={[node.view]}
          >
            {VIEW_KINDS.map((v) => {
              const disabled = v !== node.view && used.has(v);
              return (
                <button
                  key={v}
                  disabled={disabled}
                  onClick={() => {
                    setAreaView(node.id, v);
                    picker.close();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ color: v === node.view ? "var(--accent)" : "var(--text-primary)" }}
                  title={disabled ? "该视图已占用（每种视图最多一个面积）" : VIEW_META[v].label}
                >
                  {VIEW_META[v].icon}
                  {VIEW_META[v].label}
                  {v === node.view && <span className="ml-auto text-[10px]">当前</span>}
                </button>
              );
            })}
          </PopupLayer>
        </div>

        <div className="flex-1" />

        {/* 状态指示（冲突 > 错误 > 保存状态；编辑器视图，无文件/其他视图不显示） */}
        <AreaStatusIndicator view={node.view} />

        {/* 关闭 = 合并到相邻面积（最后一个面积不可关闭） */}
        {areaCount > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeArea(node.id);
            }}
            className="flex-shrink-0 px-1 py-0.5 rounded hover:opacity-70"
            style={{ color: "var(--text-muted)" }}
            title="关闭面积（合并到相邻面积）"
            aria-label={`关闭 ${meta.label} 面积`}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* 面积内容 */}
      <div className="flex-1 min-h-0">{renderView()}</div>
    </div>
  );
});
