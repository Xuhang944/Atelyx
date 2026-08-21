/**
 * 面板标签条（主窗口面积头与撕裂窗口头共用）：标签组 + 右键视图切换菜单 + ≡ 菜单 + 拖拽源。
 *
 * - 标签：点击激活；锁定标签显示锁标记且不可拖；pointer 拖拽 = 撕裂/停靠/排序（经 panelStore 会话）
 * - 视图切换：**右键头部**（标签/空白）弹出视图选择菜单——组内已有 = 激活，未占用 = 添加为本组标签，
 *   撕裂窗口占用 = 禁用并标注（无左侧下拉按钮）
 * - ≡ 菜单（右）：作用于激活标签——锁定/解锁、关闭；以及本面积——左右分割/上下分割；
 *   空面积（无标签）时变为：左右分割/上下分割/删除面积
 * - 布局操作全部经 props 回调注入宿主（AreaFrame → uiStateStore；PanelWindowRoot → panelStore）
 */
import { Lock, LockOpen, Menu } from "lucide-react";
import { memo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "@/stores/appStore";
import { usePanelStore } from "@/stores/panelStore";
import { usePopupAnchor } from "@/hooks/usePopupAnchor";
import { PopupLayer } from "@/components/common/PopupLayer";
import { Menu as MenuShell, MenuDivider, MenuItem } from "@/components/common/Menu";
import { VIEW_META } from "@/components/layout/ViewHost";
import { noteTitleFromFile, tableTitleFromFile } from "@/utils/filename";
import { VIEW_KINDS, type SplitDirection, type TabItem, type ViewKind } from "@/types";

export interface PanelTabBarProps {
  /** 宿主标识：面积 id（主窗口）或撕裂窗口 id。 */
  hostId: string;
  /** 是否为撕裂窗口（拖拽命中窗口判定用）。 */
  isPanel?: boolean;
  /** 是否显示分割菜单项（撕裂窗口无面积树，不提供分割）。 */
  allowSplit?: boolean;
  tabs: TabItem[];
  activeTabId: string | null;
  /** 全局已占用视图（含本组/其他面积/撕裂窗口），视图切换菜单据此禁用。 */
  usedViews: ViewKind[];
  /** 空面积「删除面积」可用性（最后一个面积不可删）。 */
  canDeleteArea: boolean;
  /** 状态指示（画布/表格/笔记保存/冲突等，宿主传入）。 */
  status?: ReactNode;
  /** 视图切换/添加：组内已有该视图 = 激活；否则添加为本组标签。 */
  onPickView: (view: ViewKind) => void;
  onActivate: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onToggleLock: (tabId: string) => void;
  onSplit: (direction: SplitDirection) => void;
  onDeleteArea: () => void;
  onFocusHost: () => void;
}

/**
 * 视图选择菜单（右键头部/空面积弹出，与旧「添加视图」下拉同一内容）：
 * 组内已有 = 高亮「本组」（点击激活）；未占用 = 添加；其他位置占用 = 禁用。
 */
export function ViewPickerMenu({
  x,
  y,
  onClose,
  tabs,
  usedViews,
  onPickView,
}: {
  x: number;
  y: number;
  onClose: () => void;
  tabs: TabItem[];
  usedViews: ViewKind[];
  onPickView: (view: ViewKind) => void;
}) {
  return (
    <MenuShell x={x} y={y} onClose={onClose} widthClass="w-40">
      {VIEW_KINDS.map((v) => {
        const inGroup = tabs.some((t) => t.view === v);
        const occupiedElsewhere = usedViews.includes(v) && !inGroup;
        return (
          <MenuItem
            key={v}
            disabled={occupiedElsewhere}
            onClick={() => {
              onPickView(v);
              onClose();
            }}
            className="text-xs"
            style={{ color: inGroup ? "var(--accent)" : undefined }}
            title={occupiedElsewhere ? "该视图已在其他位置（全局唯一）" : VIEW_META[v].label}
          >
            {VIEW_META[v].icon}
            {VIEW_META[v].label}
            {inGroup && <span className="ml-auto text-[10px]">本组</span>}
            {occupiedElsewhere && <span className="ml-auto text-[10px]">已占用</span>}
          </MenuItem>
        );
      })}
    </MenuShell>
  );
}

export const PanelTabBar = memo(function PanelTabBar({
  hostId,
  isPanel = false,
  allowSplit = true,
  tabs,
  activeTabId,
  usedViews,
  canDeleteArea,
  status,
  onPickView,
  onActivate,
  onCloseTab,
  onToggleLock,
  onSplit,
  onDeleteArea,
  onFocusHost,
}: PanelTabBarProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  const currentCanvasFile = useAppStore((s) => s.currentCanvasFile);
  const currentNoteFile = useAppStore((s) => s.currentNoteFile);
  const currentTableFile = useAppStore((s) => s.currentTableFile);

  /** 标签标题：画布/笔记/表格打开文件时显示文件名，否则视图名。 */
  const tabTitle = (tab: TabItem): string => {
    if (tab.view === "canvas") {
      return currentCanvasFile ? noteTitleFromFile(currentCanvasFile) : VIEW_META.canvas.label;
    }
    if (tab.view === "note") {
      return currentNoteFile ? noteTitleFromFile(currentNoteFile) : VIEW_META.note.label;
    }
    if (tab.view === "table") {
      return currentTableFile ? tableTitleFromFile(currentTableFile) : VIEW_META.table.label;
    }
    return VIEW_META[tab.view].label;
  };

  // ---------- 拖拽源（pointer 按下 → 候选 → 超阈值转正为拖拽会话） ----------
  const handlePointerDown = (e: React.PointerEvent, tab: TabItem) => {
    e.stopPropagation();
    if (tab.locked) return;
    // 捕获：指针离开标签按钮（含拖出窗口）后事件仍送达本按钮；配合 OS 按下期间隐式捕获
    e.currentTarget.setPointerCapture(e.pointerId);
    usePanelStore.getState().beginDragCandidate(tab, hostId, e.pointerId, e.clientX, e.clientY);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const ps = usePanelStore.getState();
    if (ps.drag) ps.updateDrag(e.clientX, e.clientY);
    else ps.moveDragCandidate(e.clientX, e.clientY);
  };
  const handlePointerUp = (e: React.PointerEvent, tab: TabItem) => {
    const ps = usePanelStore.getState();
    const hadDrag = !!ps.drag;
    if (hadDrag) {
      ps.finishDrag(e.clientX, e.clientY, false);
    } else if (ps.dragCandidate) {
      ps.cancelDrag();
      onActivate(tab.id);
    } else {
      onActivate(tab.id);
    }
  };

  // ---------- 右键视图切换菜单（无左侧下拉按钮） ----------
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);

  // ---------- ≡ 菜单 ----------
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menu = usePopupAnchor(menuTriggerRef);

  // ---------- tab 排序 drop 指示（本标签条为命中目标时显示插入位） ----------
  const dropTarget = usePanelStore((s) => s.dropTarget);
  const isTabTarget =
    dropTarget?.zone === "tab" && (isPanel ? dropTarget.window === hostId : dropTarget.window === "main");
  const insertIndex = isTabTarget ? (dropTarget.tabIndex ?? tabs.length) : -1;

  return (
    <div
      className="h-7 flex items-center gap-1 px-1.5 border-b flex-shrink-0 select-none min-w-0"
      style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      onClick={onFocusHost}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setViewMenu({ x: e.clientX, y: e.clientY });
      }}
      data-panel-tabbar={isPanel ? "" : undefined}
    >
      {/* 标签组（拖拽源；锁定标签显示锁标记） */}
      <div className="flex items-stretch gap-0.5 flex-1 min-w-0 overflow-x-auto no-scrollbar">
        {tabs.map((tab, i) => (
          <div key={tab.id} className="flex items-center flex-shrink-0">
            {i === insertIndex && <InsertionMarker />}
            <button
              data-tab-id={tab.id}
              onPointerDown={(e) => handlePointerDown(e, tab)}
              onPointerMove={handlePointerMove}
              onPointerUp={(e) => handlePointerUp(e, tab)}
              onPointerCancel={() => usePanelStore.getState().cancelDrag()}
              className="flex items-center gap-1 px-2 py-0.5 rounded-t text-xs border-b-2 transition-colors"
              style={{
                borderColor: tab.id === activeTabId ? "var(--accent)" : "transparent",
                color: tab.id === activeTabId ? "var(--accent)" : "var(--text-secondary)",
                background: tab.id === activeTabId ? "rgba(255,255,255,0.04)" : "transparent",
              }}
              title={`${VIEW_META[tab.view].label}${tab.locked ? "（已锁定：不可拖动/关闭）" : ""}`}
            >
              {VIEW_META[tab.view].icon}
              <span className="max-w-[120px] truncate">{tabTitle(tab)}</span>
              {tab.locked && <Lock size={9} className="flex-shrink-0" />}
            </button>
          </div>
        ))}
        {tabs.length > 0 && insertIndex === tabs.length && <InsertionMarker />}
      </div>

      <div className="flex-1" />

      {/* 状态指示 */}
      {status}

      {/* ≡ 菜单（右侧；空面积 = 分割 + 删除面积） */}
      <div className="flex-shrink-0">
        <button
          ref={menuTriggerRef}
          onClick={(e) => {
            e.stopPropagation();
            menu.toggle();
          }}
          className="flex-shrink-0 px-1.5 py-0.5 rounded hover:opacity-70"
          style={{ color: "var(--text-muted)" }}
          title={activeTab ? `标签菜单（${VIEW_META[activeTab.view].label}）` : "面积菜单"}
          aria-label="标签菜单"
        >
          <Menu size={13} />
        </button>
        <PopupLayer
          anchor={menu.anchor}
          onClose={menu.close}
          triggerRef={menuTriggerRef}
          widthClass="w-40"
          repositionDeps={[activeTabId, tabs.length]}
        >
          {activeTab ? (
            <>
              <MenuItem
                onClick={() => {
                  onToggleLock(activeTab.id);
                  menu.close();
                }}
                className="text-xs"
              >
                {activeTab.locked ? <LockOpen size={13} /> : <Lock size={13} />}
                {activeTab.locked ? "解锁" : "锁定"}
              </MenuItem>
              <MenuItem
                disabled={activeTab.locked}
                onClick={() => {
                  onCloseTab(activeTab.id);
                  menu.close();
                }}
                className="text-xs"
                title={activeTab.locked ? "已锁定，需先解锁" : "关闭当前标签（最后一个关闭后面积留空）"}
              >
                关闭
              </MenuItem>
              {allowSplit && (
                <>
                  <MenuDivider />
                  <MenuItem
                    onClick={() => {
                      onSplit("horizontal");
                      menu.close();
                    }}
                    className="text-xs"
                  >
                    左右分割
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      onSplit("vertical");
                      menu.close();
                    }}
                    className="text-xs"
                  >
                    上下分割
                  </MenuItem>
                </>
              )}
            </>
          ) : (
            <>
              {allowSplit && (
                <>
                  <MenuItem
                    onClick={() => {
                      onSplit("horizontal");
                      menu.close();
                    }}
                    className="text-xs"
                  >
                    左右分割
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      onSplit("vertical");
                      menu.close();
                    }}
                    className="text-xs"
                  >
                    上下分割
                  </MenuItem>
                  <MenuDivider />
                </>
              )}
              <MenuItem
                disabled={!canDeleteArea}
                onClick={() => {
                  onDeleteArea();
                  menu.close();
                }}
                className="text-xs"
                title={!canDeleteArea ? "最后一个面积不可删除" : "删除空面积（合并到相邻面积）"}
              >
                删除面积
              </MenuItem>
            </>
          )}
        </PopupLayer>
      </div>

      {/* 右键视图切换菜单 */}
      {viewMenu && (
        <ViewPickerMenu
          x={viewMenu.x}
          y={viewMenu.y}
          onClose={() => setViewMenu(null)}
          tabs={tabs}
          usedViews={usedViews}
          onPickView={onPickView}
        />
      )}
    </div>
  );
});

/** 标签排序插入位标记。 */
function InsertionMarker() {
  return (
    <span
      className="w-0.5 self-stretch mx-0.5 flex-shrink-0"
      style={{ background: "var(--accent)" }}
    />
  );
}
