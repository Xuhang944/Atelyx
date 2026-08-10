/**
 * 面积框：header（视图切换 + 关闭）+ 视图分派。
 *
 * - 视图切换：左上角按钮弹出视图选择器（已占用类型禁用——每种视图最多一个面积）
 * - 关闭：✕ = 合并到相邻面积（最后一个面积不可关闭，按钮隐藏）
 * - 文件打开不走面积 header（文件面板/搜索面板单击即打开到对应视图面积）
 * - 聚焦：点击面积任意处聚焦（画布快捷键门控依据）
 */
import { ChevronDown, FileText, Files, Info, LayoutTemplate, Palette, Search, Sparkles, Table as TableIcon, X } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { useUiStateStore } from "@/stores/uiStateStore";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import { AreaPlaceholder } from "@/components/layout/AreaPlaceholder";
import { CanvasView } from "@/components/layout/views/CanvasView";
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

  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useDismissOnOutside(() => setShowPicker(false));

  const used = new Set(usedKey ? usedKey.split(",") : []);

  const meta = VIEW_META[node.view];

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
        <div className="relative flex-shrink-0" ref={pickerRef}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowPicker((v) => !v);
            }}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80 text-[11px]"
            style={{ color: "var(--text-secondary)" }}
            title="切换视图类型"
          >
            {meta.icon}
            <span className="max-w-[72px] truncate" style={{ color: "var(--text-primary)" }}>
              {meta.label}
            </span>
            <ChevronDown size={11} />
          </button>
          {showPicker && (
            <div
              className="absolute left-0 top-full mt-0.5 z-50 rounded-lg border shadow-xl py-1 w-36"
              style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {VIEW_KINDS.map((v) => {
                const disabled = v !== node.view && used.has(v);
                return (
                  <button
                    key={v}
                    disabled={disabled}
                    onClick={() => {
                      setAreaView(node.id, v);
                      setShowPicker(false);
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
            </div>
          )}
        </div>

        <div className="flex-1" />

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
