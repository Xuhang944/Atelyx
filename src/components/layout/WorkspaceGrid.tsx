/**
 * 工作区面积网格：递归二分树渲染。
 *
 * Split → react-resizable-panels PanelGroup（非受控 + defaultSize，拖拽 onLayout 回写 sizes）；
 * Area → AreaFrame（标签组头部 + 视图承载）。布局操作经 uiStateStore（走既有 debounce 持久化链路）。
 *
 * 分割/合并入口变化：边右键菜单已移除（分割收进面积 ≡ 菜单，面积清理走「关闭标签 → 空面积 →
 * 删除面积」），边回归纯 resize 手柄。
 *
 * 跨窗口拖拽：面积 DOM 标注 data-drop-area，panelStore 拖拽会话按 getBoundingClientRect 命中；
 * 本组件渲染 drop 指示器 overlay（中部 = 加标签 / 四边缘 = 分割）。
 *
 * 性能：resize 拖拽每帧更新树 → 本组件重渲染，但 Area 叶子节点引用稳定
 * （utils 纯函数重建 Split 时保留叶子原引用）+ AreaFrame/PanelTabBar memo，
 * 画布/编辑器在拖边期间不重渲染。
 */
import { Fragment, useEffect, type CSSProperties } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useCanvasStore } from "@/stores/canvasStore";
import { usePanelStore } from "@/stores/panelStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { collectAreas, collectAllViews, findArea } from "@/utils/workspaceLayout";
import { AreaFrame } from "@/components/layout/AreaFrame";
import { DragGhost } from "@/components/layout/DragGhost";
import type { LayoutNode, SplitNode } from "@/types";

/** 递归渲染节点。 */
function GridNode({
  node,
  onFocus,
  usedKey,
  areaCount,
}: {
  node: LayoutNode;
  onFocus: (id: string) => void;
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
  // 非受控 + defaultSize：sizes 只作为挂载初值与持久化记录（拖拽后内部布局保持，onLayout 回写树）。
  // key=split.id：布局操作（分割/删除面积/切换布局）产生新节点结构时强制重挂，defaultSize 重新生效。
  // id + order 必须稳定且唯一：react-resizable-panels 对动态渲染的面板要求同时提供 id 与 order
  // 才按 id 关联布局状态——缺一会在面板增删重挂后状态错位（拖边方向反/跨面积联动）。
  return (
    <PanelGroup
      key={node.id}
      id={`group-${node.id}`}
      direction={node.direction}
      onLayout={(sizes) => setLayoutSizes(node.id, sizes)}
      className="h-full w-full"
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <SplitHandle key={`handle-${node.id}-${i}`} />}
          <Panel
            id={`panel-${child.id}`}
            order={i}
            defaultSize={node.sizes[i]}
            minSize={12}
            className="min-w-0 min-h-0"
          >
            <GridNode node={child} onFocus={onFocus} usedKey={usedKey} areaCount={areaCount} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}

/** 边（纯 resize 手柄；右键菜单已随分割/合并入口迁移到 ≡ 菜单而移除）。
 * 方向化样式（竖边 w / 横边 h + hover 强调）在 styles/index.css 按 data 属性统一处理。 */
function SplitHandle() {
  return <PanelResizeHandle className="flex-shrink-0" />;
}

/** 跨窗口拖拽 drop 指示器：命中面积中部 = 加标签高亮整块；四边缘 = 分割带。 */
function DropIndicatorOverlay() {
  const dropTarget = usePanelStore((s) => s.dropTarget);
  if (!dropTarget || dropTarget.kind !== "area" || dropTarget.window !== "main" || !dropTarget.areaId) {
    return null;
  }
  const el = document.querySelector(`[data-drop-area="${dropTarget.areaId}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const zone = dropTarget.zone;
  const base: CSSProperties = {
    position: "fixed",
    pointerEvents: "none",
    zIndex: 40,
    borderRadius: 4,
    background: "color-mix(in srgb, var(--accent) 22%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--accent) 60%, transparent)",
  };
  let style: CSSProperties;
  if (zone === "center" || zone === "tab") {
    style = { ...base, left: r.left, top: r.top, width: r.width, height: r.height };
  } else if (zone === "left") {
    style = { ...base, left: r.left, top: r.top, width: r.width * 0.12, height: r.height };
  } else if (zone === "right") {
    style = { ...base, left: r.right - r.width * 0.12, top: r.top, width: r.width * 0.12, height: r.height };
  } else if (zone === "top") {
    style = { ...base, left: r.left, top: r.top, width: r.width, height: r.height * 0.12 };
  } else {
    style = { ...base, left: r.left, top: r.bottom - r.height * 0.12, width: r.width, height: r.height * 0.12 };
  }
  return <div style={style} />;
}

/** 工作区面积网格根：聚焦兜底 + 派发渲染。 */
export function WorkspaceGrid({ tree }: { tree: LayoutNode }) {
  const focusedAreaId = useUiStateStore((s) => s.focusedAreaId);
  const setFocusedArea = useUiStateStore((s) => s.setFocusedArea);
  const detachedWindows = useUiStateStore((s) => s.detachedWindows);

  // 聚焦兜底：聚焦面积被关闭/布局切换后失效 → 聚焦第一个面积
  useEffect(() => {
    if (!focusedAreaId || !findArea(tree, focusedAreaId)) {
      const first = collectAreas(tree)[0];
      if (first) setFocusedArea(first.id);
    }
  }, [focusedAreaId, tree, setFocusedArea]);

  const areas = collectAreas(tree);
  // 稳定键（全局已占用视图集合的排序拼接，含撕裂窗口）：resize 拖拽时不变，AreaFrame memo 可跳过
  const usedKey = [...new Set(collectAllViews(tree, detachedWindows))].sort().join(",");

  // 布局中无画布面积时清属性面板选中（画布未渲染，InspectorPanel 的 setCenter 定位无实例）
  const hasCanvas = areas.some((a) => a.tabs.some((t) => t.view === "canvas"));
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
      <DropIndicatorOverlay />
      <DragGhost />
    </div>
  );
}
