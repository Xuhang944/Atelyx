/**
 * 面积框：标签头（PanelTabBar）+ 视图承载（ViewHost）。
 *
 * - 标签组：点击切换；右键头部弹视图切换菜单；拖拽撕裂/停靠/排序（拖拽会话在 panelStore）
 * - ≡ 菜单：锁定/关闭（激活标签）、左右/上下分割、删除面积（空面积）
 * - 空面积：内容区右键同样可添加视图（与头部右键一致）
 * - 布局操作直接走 uiStateStore（主窗口为布局权威）
 * - 聚焦：点击面积任意处聚焦（画布快捷键门控依据）
 */
import { memo, useState } from "react";
import { useUiStateStore } from "@/stores/uiStateStore";
import { PanelTabBar, ViewPickerMenu } from "@/components/layout/PanelTabBar";
import { ViewHost, ViewStatusIndicator } from "@/components/layout/ViewHost";
import type { AreaNode, ViewKind } from "@/types";

export const AreaFrame = memo(function AreaFrame({
  node,
  onFocus,
  usedKey,
  areaCount,
}: {
  node: AreaNode;
  onFocus: (id: string) => void;
  /** 全局已占用视图集合的稳定键（WorkspaceGrid 计算，含撕裂窗口；resize 时不变，memo 跳过重渲染）。 */
  usedKey: string;
  /** 当前布局面积总数（= 1 时「删除面积」禁用）。 */
  areaCount: number;
}) {
  const addViewToArea = useUiStateStore((s) => s.addViewToArea);
  const setActiveTab = useUiStateStore((s) => s.setActiveTab);
  const closeTab = useUiStateStore((s) => s.closeTab);
  const setTabLocked = useUiStateStore((s) => s.setTabLocked);
  const splitArea = useUiStateStore((s) => s.splitArea);
  const closeArea = useUiStateStore((s) => s.closeArea);
  const setFocusedArea = useUiStateStore((s) => s.setFocusedArea);

  const used = new Set(usedKey ? (usedKey.split(",") as ViewKind[]) : []);
  const activeTab = node.tabs.find((t) => t.id === node.activeTabId) ?? node.tabs[0] ?? null;

  // 空面积内容区右键视图菜单（与头部右键一致）
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className="h-full flex flex-col min-h-0"
      data-drop-area={node.id}
      onClick={() => onFocus(node.id)}
    >
      <PanelTabBar
        hostId={node.id}
        tabs={node.tabs}
        activeTabId={node.activeTabId}
        usedViews={[...used]}
        canDeleteArea={areaCount > 1}
        status={activeTab ? <ViewStatusIndicator view={activeTab.view} /> : null}
        onPickView={(view) => addViewToArea(node.id, view)}
        onActivate={(tabId) => setActiveTab(node.id, tabId)}
        onCloseTab={(tabId) => closeTab(node.id, tabId)}
        onToggleLock={(tabId) => {
          const t = node.tabs.find((x) => x.id === tabId);
          if (t) setTabLocked(node.id, tabId, !t.locked);
        }}
        onSplit={(dir) => splitArea(node.id, dir)}
        onDeleteArea={() => closeArea(node.id)}
        onFocusHost={() => setFocusedArea(node.id)}
      />
      {/* 面积内容（空面积渲染占位引导，右键可添加视图） */}
      <div
        className="flex-1 min-h-0"
        onContextMenu={
          activeTab
            ? undefined
            : (e) => {
                e.preventDefault();
                e.stopPropagation();
                setEmptyMenu({ x: e.clientX, y: e.clientY });
              }
        }
      >
        <ViewHost view={activeTab?.view ?? "empty"} hostId={node.id} />
      </div>
      {emptyMenu && (
        <ViewPickerMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          onClose={() => setEmptyMenu(null)}
          tabs={node.tabs}
          usedViews={[...used]}
          onPickView={(view) => addViewToArea(node.id, view)}
        />
      )}
    </div>
  );
});
