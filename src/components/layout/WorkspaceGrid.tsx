/**
 * 工作区面积网格：递归二分树渲染。
 *
 * Split → react-resizable-panels PanelGroup（非受控 + defaultSize，拖拽 onLayout 回写 sizes）
 * + 边右键菜单；Area → AreaFrame。所有布局操作经 uiStateStore（走既有 debounce 持久化链路）。
 *
 * 性能：resize 拖拽每帧更新树 → 本组件重渲染，但 Area 叶子节点引用稳定
 * （utils 纯函数重建 Split 时保留叶子原引用）+ AreaFrame/CanvasView memo，
 * 画布/编辑器在拖边期间不重渲染。
 */
import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";
import {
  adjacentArea,
  collectAreas,
  findArea,
} from "@/utils/workspaceLayout";
import { AreaFrame } from "@/components/layout/AreaFrame";
import type { LayoutNode, SplitDirection, SplitNode } from "@/types";

/** 递归渲染节点。 */
function GridNode({
  node,
  onFocus,
  usedKey,
  areaCount,
}: {
  node: LayoutNode;
  onFocus: (id: string) => void;
  /** 已占用视图集合的稳定键（AreaFrame 据此禁用重复类型，resize 时不变不重渲染）。 */
  usedKey: string;
  areaCount: number;
}) {
  if (node.kind === "area") {
    return <AreaFrame node={node} onFocus={onFocus} usedKey={usedKey} areaCount={areaCount} />;
  }
  return <SplitView node={node} onFocus={onFocus} usedKey={usedKey} areaCount={areaCount} />;
}

function SplitView({
  node,
  onFocus,
  usedKey,
  areaCount,
}: {
  node: SplitNode;
  onFocus: (id: string) => void;
  usedKey: string;
  areaCount: number;
}) {
  const setLayoutSizes = useUiStateStore((s) => s.setLayoutSizes);
  const [a, b] = node.children;
  // 非受控 + defaultSize：sizes 只作为挂载初值与持久化记录（拖拽后内部布局保持，onLayout 回写树）。
  // key=split.id：布局操作（分割/合并/切换布局）产生新节点结构时强制重挂，defaultSize 重新生效。
  return (
    <PanelGroup
      key={node.id}
      direction={node.direction}
      onLayout={(sizes) => setLayoutSizes(node.id, [sizes[0] ?? 50, sizes[1] ?? 50])}
      className="h-full w-full"
    >
      <Panel key={a.id} defaultSize={node.sizes[0]} minSize={12} className="min-w-0 min-h-0">
        <GridNode node={a} onFocus={onFocus} usedKey={usedKey} areaCount={areaCount} />
      </Panel>
      <SplitHandle split={node} />
      <Panel key={b.id} defaultSize={node.sizes[1]} minSize={12} className="min-w-0 min-h-0">
        <GridNode node={b} onFocus={onFocus} usedKey={usedKey} areaCount={areaCount} />
      </Panel>
    </PanelGroup>
  );
}

/** 边（PanelResizeHandle）+ 右键菜单：分割相邻面积 / 向两侧合并。 */
function SplitHandle({ split }: { split: SplitNode }) {
  const splitArea = useUiStateStore((s) => s.splitArea);
  const mergeSibling = useUiStateStore((s) => s.mergeSibling);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const { ref: menuRef, pos: menuPos } = useClampedMenuPosition(menu?.x ?? 0, menu?.y ?? 0);
  // 点击菜单外 / Esc 关闭
  useDismissOnOutside(close, menuRef);

  // 竖边（左右并排）→ 分割目标为左/右相邻叶子面积，分割方向 = 上下（新边横）
  const isVerticalEdge = split.direction === "horizontal";
  const splitDir: SplitDirection = isVerticalEdge ? "vertical" : "horizontal";
  const a = adjacentArea(split, 0);
  const b = adjacentArea(split, 1);
  const edgeLabel = isVerticalEdge ? "左" : "上";
  const edgeLabel2 = isVerticalEdge ? "右" : "下";

  return (
    <>
      <PanelResizeHandle
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={isVerticalEdge ? "w-1 flex-shrink-0 transition-colors hover:bg-[var(--accent)]/50" : "h-1 flex-shrink-0 transition-colors hover:bg-[var(--accent)]/50"}
        style={{ background: "var(--border)" }}
      />
      {menu && (
        <div
          ref={menuRef}
          className="fixed border rounded shadow-lg py-1 z-50 w-44"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            background: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              if (a) splitArea(a.id, splitDir);
              close();
            }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            分割{edgeLabel}侧面积
          </button>
          <button
            onClick={() => {
              if (b) splitArea(b.id, splitDir);
              close();
            }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            分割{edgeLabel2}侧面积
          </button>
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
          <button
            onClick={() => {
              mergeSibling(split.id, 1);
              close();
            }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
            title={`${edgeLabel}侧面积消失，${edgeLabel2}侧接管`}
          >
            向{edgeLabel2}合并
          </button>
          <button
            onClick={() => {
              mergeSibling(split.id, 0);
              close();
            }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
            title={`${edgeLabel2}侧面积消失，${edgeLabel}侧接管`}
          >
            向{edgeLabel}合并
          </button>
        </div>
      )}
    </>
  );
}

/** 工作区面积网格根：聚焦兜底 + 派发渲染。 */
export function WorkspaceGrid({ tree }: { tree: LayoutNode }) {
  const focusedAreaId = useUiStateStore((s) => s.focusedAreaId);
  const setFocusedArea = useUiStateStore((s) => s.setFocusedArea);

  // 聚焦兜底：聚焦面积被关闭/布局切换后失效 → 聚焦第一个面积
  useEffect(() => {
    if (!focusedAreaId || !findArea(tree, focusedAreaId)) {
      const first = collectAreas(tree)[0];
      if (first) setFocusedArea(first.id);
    }
  }, [focusedAreaId, tree, setFocusedArea]);

  const areas = collectAreas(tree);
  // 稳定键（视图占用集合的排序拼接）：resize 拖拽时不变，AreaFrame memo 可跳过
  const usedKey = areas
    .filter((a) => a.view !== "empty")
    .map((a) => a.view)
    .sort()
    .join(",");

  // 布局中无画布面积时清属性面板选中（画布未渲染，InspectorPanel 的 setCenter 定位无实例）
  const hasCanvas = areas.some((a) => a.view === "canvas");
  useEffect(() => {
    if (!hasCanvas) useCanvasStore.getState().selectNode(null);
  }, [hasCanvas]);

  return (
    <div className="h-full w-full" style={{ background: "var(--bg-primary)" }}>
      <GridNode
        node={tree}
        onFocus={setFocusedArea}
        usedKey={usedKey}
        areaCount={areas.length}
      />
    </div>
  );
}
