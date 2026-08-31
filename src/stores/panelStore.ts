/**
 * 多窗口面板运行时（每窗口一个实例；角色由窗口 label 决定）。
 *
 * 主窗口（label "main"）：
 * - 布局权威在 uiStateStore；本 store 负责跨窗口拖拽会话编排、撕裂窗口 OS 生命周期
 *   （创建/回收）、视图交接（releaseView：flush + 清内存）、协作连接宿主重算、
 *   撕裂窗口恢复与窗口 bounds 注册表
 * 撕裂窗口（label "panel-<id>"）：
 * - 镜像自身标签组（layout-changed 广播同步）+ 本地操作乐观应用并请求主窗口（panel-layout-op）
 * - 启动握手（panel-init-request → panel-init）；关闭前 flush 托管视图 + panel-closed 上报
 *
 * 拖拽：源窗口持有会话（Windows/GTK 鼠标按下隐式捕获保证窗口外仍收事件），广播屏幕坐标；
 * 各窗口把屏幕坐标换算为本地 client 坐标命中自身 drop 区并渲染指示器（dropTarget）；
 * 主窗口在 drag-end 按最新命中应用布局操作（落在主窗口 chrome 上 = 取消；
 * 未命中任何应用窗口 = 撕裂建新窗）。
 *
 * 视图跨窗口移动的落盘顺序：主窗口先应用布局（sync）再广播；源窗口收到 layout-changed
 * 发现视图已离开后 releaseView（flush + 清内存）——与既有 watcher + 乐观锁合并兼容
 * （磁盘为真相源，晚到的写盘经合并收敛）。
 */
import { create } from "zustand";
import type { LayoutNode, SplitDirection, TabItem, ViewKind } from "@/types";
import { useUiStateStore, setUiStatePersistSuppressed } from "@/stores/uiStateStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useTableStore } from "@/stores/tableStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useCollabStore } from "@/stores/collabStore";
import { useVaultStore } from "@/stores/vaultStore";
import { VIEW_LABELS } from "@/constants/views";
import { collectPanels, collectTabs, findViewHost } from "@/utils/workspaceLayout";
import * as bus from "@/services/windowBus";
import type { DropTargetInfo, PanelDragStartPayload, WindowRect } from "@/services/windowBus";
import {
  closeWindowByLabel,
  createPanelWindow,
  getCurrentOuterPosition,
  getCurrentOuterSize,
  getCurrentWindowLabel,
  isMouseLeftDown,
  onWindowMoved,
  setWindowTitle,
} from "@/services/window";
import type { DetachedWindow } from "@/types/workspaceLayout";

/** 拖拽转正阈值（px）：按下移动超过才视为拖拽，否则为点击激活标签。 */
const DRAG_THRESHOLD_PX = 4;
/** 撕裂窗口默认尺寸（logical px）。 */
const PANEL_WINDOW_SIZE = { width: 420, height: 560 };
/** 面板窗口 label 前缀。 */
export const PANEL_LABEL_PREFIX = "panel-";
/**
 * 拖拽看门狗（ms）：源窗口把标签拖出自身窗口后，webview 可能收不到窗口外的 pointerup
 * （释放事件丢失 → 各窗口 drop 指示器残留、拖拽会话卡死）。非 Windows 平台或轮询
 * 不可用时的最终兜底：最后位置移出自身窗口后超过该时长无新事件 → 按最后坐标自动完成
 * 落点解析（撕裂/停靠）并广播结束。Windows 上由「左键物理状态轮询」先于本兜底生效。
 */
const DRAG_WATCHDOG_MS = 2000;
/** 左键物理状态轮询间隔（ms）：拖拽活跃期间检测鼠标松开（释放事件丢失的主修复）。 */
const MOUSE_POLL_INTERVAL_MS = 120;

/** 拖拽会话（源窗口持有）。 */
export interface DragSession {
  tabId: string;
  view: ViewKind;
  /** 源窗口 label（"main" 或 panel label）。 */
  sourceWindow: string;
  /** 源宿主：主窗口面板 id 或撕裂窗口 id。 */
  sourceHost: string;
  screenX: number;
  screenY: number;
  /** 拖拽会话序号（end 广播防重解析用）。 */
  seq: number;
}

/** 按下但未转正的候选（点击激活 vs 拖拽判定）。 */
interface DragCandidate {
  tab: TabItem;
  sourceHost: string;
  pointerId: number;
  x: number;
  y: number;
}

/** 本窗口布局镜像（主窗口直连 uiStateStore；撕裂窗口经 layout-changed 广播）。 */
interface LayoutMirror {
  activeTree: LayoutNode;
  detachedWindows: DetachedWindow[];
}

interface PanelStore {
  role: "main" | "panel";
  /** 本窗口 label（main 为 "main"；撕裂窗口为 panel-<id>）。 */
  windowId: string;
  /** 撕裂窗口镜像标签组（panel 用；main 的权威在 uiStateStore）。 */
  panelTabs: TabItem[];
  panelActiveTabId: string | null;
  /** panel 是否已完成握手（panel-init）。 */
  panelReady: boolean;
  /** 本窗口发起的拖拽会话（仅源窗口非 null）。 */
  drag: DragSession | null;
  /** 主窗口对当前任意拖拽的记录（自身或外来，drag-end 解析用）。 */
  activeDrag: DragSession | null;
  /** 按下候选（未转正）。 */
  dragCandidate: DragCandidate | null;
  /** 本窗口当前 drop 命中（渲染指示器）。 */
  dropTarget: DropTargetInfo | null;
  /** 面板窗口最近上报的命中（主窗口 drag-end 解析用）。 */
  lastPanelTarget: DropTargetInfo | null;
  /** 本窗口屏幕位置缓存（屏幕坐标换算）。 */
  windowPos: { x: number; y: number };
  /** 窗口 bounds 注册表（主窗口维护）。 */
  windowBounds: Record<string, WindowRect>;
  /** 布局镜像（主窗口 = uiStateStore 权威；撕裂窗口 = 广播）。 */
  layoutMirror: LayoutMirror | null;
  /** 已创建撕裂窗口的 OS label 集合（恢复防重）。 */
  createdPanels: Set<string>;

  /** 主窗口初始化：缓存窗口位置 + 订阅 uiState/appStore + 注册事件监听。 */
  initMain: () => Promise<void>;
  /** 撕裂窗口初始化：抑制 uiState 持久化 + 握手 + 事件监听。 */
  initPanel: () => Promise<void>;
  /** 应用 panel-init：镜像标签组 + 仓库/文件状态 + 加载托管视图 + 协作宿主重算。 */
  applyPanelInit: (payload: bus.PanelInitPayload) => void;
  /** 上报本窗口 bounds（窗口移动/缩放后，防抖由调用方控制）。 */
  reportBounds: () => Promise<void>;

  /** 拖拽源：记录按下候选（锁定标签不进入）。 */
  beginDragCandidate: (tab: TabItem, sourceHost: string, pointerId: number, x: number, y: number) => void;
  /** 拖拽候选移动：超阈值转正为拖拽会话，返回是否已转正。 */
  moveDragCandidate: (clientX: number, clientY: number) => boolean;
  /** 拖拽中移动：更新屏幕坐标 + 广播 + 本窗口命中。 */
  updateDrag: (clientX: number, clientY: number) => void;
  /** 拖拽结束（pointerup）：广播 + 主窗口解析落点。 */
  finishDrag: (clientX: number, clientY: number, cancelled: boolean) => void;
  /** 取消拖拽（pointercancel/看门狗）。 */
  cancelDrag: () => void;

  /** 撕裂窗口本地操作（乐观镜像 + 请求主窗口）。 */
  panelSetActive: (tabId: string) => void;
  panelCloseTab: (tabId: string) => void;
  panelSetLocked: (tabId: string, locked: boolean) => void;
  panelSetTabView: (tabId: string, view: ViewKind) => void;
  panelMoveTab: (tabId: string, toIndex: number) => void;
  panelAddView: (view: ViewKind) => void;

  /** 释放本窗口托管的视图（flush 落盘 + 清内存；视图离开本窗口时调用）。 */
  releaseView: (view: ViewKind) => Promise<void>;
  /** 协作连接宿主重算：本窗口托管画布/表格/笔记任一视图且协作开启 → 连接，否则断开。 */
  syncCollabHost: () => void;
  /** 主窗口：恢复持久化的撕裂窗口。 */
  restoreDetachedWindows: () => Promise<void>;
  /** 主窗口：撕裂（面板来源，含交接 + 建窗）。 */
  tearOff: (panelId: string, tabId: string, screenX: number, screenY: number) => Promise<void>;
  /** 主窗口：撕裂（撕裂窗口来源，拖到窗外）。 */
  tearOffFromPanel: (sourceWindowId: string, tabId: string, screenX: number, screenY: number) => Promise<void>;
  /** 主窗口：回收撕裂窗口 OS 窗口（条目已移除时调用）。 */
  closePanelWindow: (windowId: string) => Promise<void>;
}

/** 屏幕坐标 → 撕裂窗口 bounds（窗口创建在鼠标附近）。 */
function boundsNear(x: number, y: number): WindowRect {
  return {
    x: Math.round(x - PANEL_WINDOW_SIZE.width / 2),
    y: Math.round(y - 24),
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
  };
}

/** 点是否在窗口矩形内。 */
function pointInRect(x: number, y: number, r: WindowRect | undefined): boolean {
  if (!r) return false;
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** 标签条插入位：光标在标签前半 → 该标签下标，否则末尾（主/撕裂窗口命中测试共用）。 */
function tabIndexAt(tabEls: HTMLElement[], cx: number): number {
  for (let i = 0; i < tabEls.length; i++) {
    const t = tabEls[i].getBoundingClientRect();
    if (cx < t.left + t.width / 2) return i;
  }
  return tabEls.length;
}

/** 主窗口 drop 命中：按面板 DOM rect 计算 zone（头部 = tab 排序；四边缘 = 分割；中部 = 加标签）。 */
function hitTestMainWindow(
  cx: number,
  cy: number,
  windowId: string,
): DropTargetInfo | null {
  const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-drop-panel]"));
  for (const el of panels) {
    const r = el.getBoundingClientRect();
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
    // 头部条（tab 排序区）：面板 header 顶部 28px
    if (cy <= r.top + 28) {
      const tabEls = Array.from(el.querySelectorAll<HTMLElement>("[data-tab-id]"));
      return {
        window: windowId,
        panelId: el.dataset.dropPanel,
        zone: "tab",
        tabIndex: tabIndexAt(tabEls, cx),
      };
    }
    const w = r.width;
    const h = r.height;
    const zone: DropTargetInfo["zone"] =
      cx - r.left < w * 0.12
        ? "left"
        : r.right - cx < w * 0.12
          ? "right"
          : cy - r.top < h * 0.12
            ? "top"
            : r.bottom - cy < h * 0.12
              ? "bottom"
              : "center";
    return { window: windowId, panelId: el.dataset.dropPanel, zone };
  }
  return null;
}

/** 撕裂窗口 drop 命中：整体 = 加标签；头部条 = tab 排序。 */
function hitTestPanelWindow(cx: number, cy: number, windowId: string): DropTargetInfo | null {
  const root = document.querySelector<HTMLElement>("[data-panel-drop-root]");
  if (!root) return null;
  const r = root.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
  const tabbar = document.querySelector<HTMLElement>("[data-panel-tabbar]");
  if (tabbar) {
    const tr = tabbar.getBoundingClientRect();
    if (cy >= tr.top && cy <= tr.bottom) {
      const tabEls = Array.from(tabbar.querySelectorAll<HTMLElement>("[data-tab-id]"));
      return { window: windowId, zone: "tab", tabIndex: tabIndexAt(tabEls, cx) };
    }
  }
  return { window: windowId, zone: "center" };
}

/** 结构签名（排除 sizes：resize 拖拽不广播 layout-changed 给撕裂窗口）。 */
function layoutSig(mirror: LayoutMirror): string {
  const panels = collectPanels(mirror.activeTree);
  return JSON.stringify({
    panels: panels.map((p) => ({ id: p.id, tabs: p.tabs.map((t) => `${t.id}:${t.view}:${t.locked ? 1 : 0}`), active: p.activeTabId })),
    splits: (() => {
      const ids: string[] = [];
      const walk = (n: LayoutNode): void => {
        if (n.kind === "split") {
          ids.push(n.id);
          n.children.forEach(walk);
        }
      };
      walk(mirror.activeTree);
      return ids;
    })(),
    detached: mirror.detachedWindows.map((w) => ({
      id: w.id,
      tabs: w.tabs.map((t) => `${t.id}:${t.view}:${t.locked ? 1 : 0}`),
      active: w.activeTabId,
    })),
  });
}

/** 面板窗口标签标题（窗口标题 = 激活标签视图名）。 */
function titleOfTabs(tabs: TabItem[], activeTabId: string | null): string {
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  return active ? VIEW_LABELS[active.view] : "面板";
}

export const usePanelStore = create<PanelStore>((set, get) => {
  /** 拖拽看门狗 timer（源窗口；释放事件丢失时按最后坐标自动完成落点）。 */
  let dragWatchdog: number | null = null;
  /** 拖拽会话递增序号（end 广播防重解析用）。 */
  let dragSeqCounter = 0;
  /** 主窗口最近已解析的拖拽序号（防本地 finishDrag 与 end 广播重复解析落点）。 */
  let lastResolvedSeq = -1;
  /** 左键状态轮询 timer（源窗口；释放事件丢失的主修复：物理检测鼠标松开）。 */
  let mousePollTimer: number | null = null;
  /** 平台是否支持左键状态轮询（null = 未探测；Windows 支持，其他平台不可用）。 */
  let mousePollSupported: boolean | null = null;

  /** 停止左键状态轮询。 */
  const stopMousePoll = (): void => {
    if (mousePollTimer !== null) {
      window.clearInterval(mousePollTimer);
      mousePollTimer = null;
    }
  };

  /** 启动左键状态轮询：拖拽活跃期间检测鼠标物理松开（窗口外 pointerup 丢失的根因修复）。 */
  const startMousePoll = (): void => {
    stopMousePoll();
    void (async () => {
      if (mousePollSupported === null) {
        mousePollSupported = (await isMouseLeftDown()) !== null;
      }
      if (!mousePollSupported) return;
      mousePollTimer = window.setInterval(() => {
        void isMouseLeftDown().then((down) => {
          if (down !== false) return;
          stopMousePoll();
          const s = usePanelStore.getState();
          if (s.drag) {
            s.finishDrag(s.drag.screenX - s.windowPos.x, s.drag.screenY - s.windowPos.y, false);
          }
        });
      }, MOUSE_POLL_INTERVAL_MS);
    })();
  };

  /** 重置看门狗：拖拽会话在自身窗口外且长时间无事件 → 视为已释放，按最后坐标解析落点。 */
  const armDragWatchdog = (): void => {
    if (dragWatchdog !== null) window.clearTimeout(dragWatchdog);
    dragWatchdog = window.setTimeout(() => {
      dragWatchdog = null;
      const s = usePanelStore.getState();
      if (!s.drag) return;
      // 最后位置仍在自身窗口内 = 用户悬停未离开，不自动完成（等待真实释放/继续拖动）
      if (pointInRect(s.drag.screenX, s.drag.screenY, s.windowBounds[s.windowId])) return;
      s.finishDrag(s.drag.screenX - s.windowPos.x, s.drag.screenY - s.windowPos.y, false);
    }, DRAG_WATCHDOG_MS);
  };

  /** 广播 layout-changed（主窗口布局变更后）。 */
  const broadcastLayout = (): void => {
    const mirror = get().layoutMirror;
    if (!mirror) return;
    void bus.emitLayoutChanged({
      workspaceLayouts: useUiStateStore.getState().workspaceLayouts,
      detachedWindows: mirror.detachedWindows,
      activeLayoutId: useUiStateStore.getState().activeLayoutId,
    });
  };

  /** 本窗口命中的 drop 区（按屏幕坐标换算本地 client 坐标），广播给主窗口记录。 */
  const computeOwnHit = (screenX: number, screenY: number): void => {
    const { role, windowId, windowPos } = get();
    const cx = screenX - windowPos.x;
    const cy = screenY - windowPos.y;
    const hit = role === "main" ? hitTestMainWindow(cx, cy, windowId) : hitTestPanelWindow(cx, cy, windowId);
    set({ dropTarget: hit });
    void bus.emitPanelDragTarget({ window: windowId, target: hit });
  };

  /** 主窗口 drag-end 解析落点并应用布局操作。 */
  const resolveDrop = (screenX: number, screenY: number): void => {
    const drag = get().activeDrag;
    if (!drag) {
      return;
    }
    const ui = useUiStateStore.getState();
    const { windowPos, windowBounds, lastPanelTarget } = get();

    // 1. 主窗口面板命中
    const mainHit = hitTestMainWindow(screenX - windowPos.x, screenY - windowPos.y, "main");
    if (mainHit) {
      const panelId = mainHit.panelId;
      if (!panelId) return;
      const fromPanel = drag.sourceWindow === "main" ? drag.sourceHost : undefined;
      if (mainHit.zone === "center") {
        if (drag.sourceWindow === "main") {
          if (fromPanel === panelId) return; // 原面板：无操作
          ui.moveTabBetweenPanels(fromPanel!, panelId, drag.tabId);
        } else {
          ui.dockTabIntoPanel(panelId, drag.tabId);
        }
        return;
      }
      if (mainHit.zone === "tab") {
        const index = mainHit.tabIndex;
        if (drag.sourceWindow === "main") {
          if (fromPanel === panelId) ui.moveTabWithinPanel(panelId, drag.tabId, index ?? 0);
          else ui.moveTabBetweenPanels(fromPanel!, panelId, drag.tabId, index);
        } else {
          ui.dockTabIntoPanel(panelId, drag.tabId, index);
        }
        return;
      }
      // 边缘 = 分割出独立面板承载该标签（同级插入：左/上 = 前，右/下 = 后）
      const dir: SplitDirection =
        mainHit.zone === "left" || mainHit.zone === "right" ? "horizontal" : "vertical";
      const position: "before" | "after" =
        mainHit.zone === "left" || mainHit.zone === "top" ? "before" : "after";
      const newPanelId = ui.splitPanel(panelId, dir, position);
      if (!newPanelId) return;
      if (drag.sourceWindow === "main") {
        ui.moveTabBetweenPanels(fromPanel!, newPanelId, drag.tabId);
      } else {
        ui.dockTabIntoPanel(newPanelId, drag.tabId);
      }
      return;
    }

    // 2. 撕裂窗口命中（最近上报 + 终点落在该窗口 bounds 内）
    if (lastPanelTarget && pointInRect(screenX, screenY, windowBounds[lastPanelTarget.window])) {
      ui.dockTabIntoDetached(lastPanelTarget.window, drag.tabId, lastPanelTarget.tabIndex);
      return;
    }

    // 3. 未命中应用窗口：落在主窗口 chrome 内 = 取消；窗外 = 撕裂建新窗
    if (pointInRect(screenX, screenY, windowBounds.main)) {
      return;
    }
    if (drag.sourceWindow === "main") {
      void get().tearOff(drag.sourceHost, drag.tabId, screenX, screenY);
    } else {
      void get().tearOffFromPanel(drag.sourceWindow, drag.tabId, screenX, screenY);
    }
  };

  /**
   * 拖拽结束共享骨架（finishDrag/cancelDrag 合流）：停左键轮询 + 清看门狗 + 广播 end +
   * 清全套拖拽状态。坐标为 null = 取消路径，用会话最后已知屏幕坐标；
   * cancelled = true 时主窗口不解析落点。
   */
  const endDrag = (screenX: number | null, screenY: number | null, cancelled: boolean): void => {
    stopMousePoll();
    if (dragWatchdog !== null) {
      window.clearTimeout(dragWatchdog);
      dragWatchdog = null;
    }
    const { drag, windowId } = get();
    set({ dragCandidate: null });
    if (!drag) return;
    // 取消路径无实时坐标：用会话最后已知屏幕坐标
    const x = screenX ?? drag.screenX;
    const y = screenY ?? drag.screenY;
    void bus.emitPanelDragEnd({ sourceWindow: windowId, screenX: x, screenY: y, cancelled, seq: drag.seq });
    try {
      // 主窗口本地拖拽：直接解析（广播可能不自送达）；seq 防重（end 广播自送达时跳过）
      if (windowId === "main" && !cancelled && drag.seq !== lastResolvedSeq) {
        lastResolvedSeq = drag.seq;
        resolveDrop(x, y);
      }
    } finally {
      // 无论解析是否异常，拖拽会话与指示器必须清理（防残留）
      set({ drag: null, activeDrag: null, dropTarget: null, dragCandidate: null });
    }
  };

  return {
    role: "main",
    windowId: "main",
    panelTabs: [],
    panelActiveTabId: null,
    panelReady: false,
    drag: null,
    activeDrag: null,
    dragCandidate: null,
    dropTarget: null,
    lastPanelTarget: null,
    windowPos: { x: 0, y: 0 },
    windowBounds: {},
    layoutMirror: null,
    createdPanels: new Set<string>(),

    initMain: async () => {
      set({ role: "main", windowId: "main" });
      // 窗口位置缓存
      try {
        const pos = await getCurrentOuterPosition();
        set({ windowPos: pos });
        const size = await getCurrentOuterSize();
        set((s) => ({ windowBounds: { ...s.windowBounds, main: { ...pos, ...size } } }));
      } catch {
        /* 位置读取失败仅影响拖拽坐标换算，降级为 0,0 */
      }
      void onWindowMoved(() => {
        void getCurrentOuterPosition().then((pos) => {
          set({ windowPos: pos });
          set((s) => {
            const prev = s.windowBounds.main;
            return { windowBounds: { ...s.windowBounds, main: { ...pos, width: prev?.width ?? 0, height: prev?.height ?? 0 } } };
          });
        });
        // 防抖上报 bounds（窗口拖拽期间高频事件）
        window.setTimeout(() => void get().reportBounds(), 300);
      });

      // 布局镜像 + 广播 + 协作宿主 + 撕裂窗口 OS 回收 + 视图回归重载（aichat 会话跨窗口后重读盘）
      const syncFromUi = (): void => {
        const ui = useUiStateStore.getState();
        const mirror: LayoutMirror = {
          activeTree: ui.workspaceLayouts.find((l) => l.id === ui.activeLayoutId)?.tree ?? ui.workspaceLayouts[0].tree,
          detachedWindows: ui.detachedWindows,
        };
        const prev = get().layoutMirror;
        set({ layoutMirror: mirror });
        if (prev) {
          const before = new Set(collectTabs(prev.activeTree).map((t) => t.view));
          const after = new Set(collectTabs(mirror.activeTree).map((t) => t.view));
          // 撕裂出去的 AI 会话视图回归主窗口：重读盘（面板窗口可能已改会话）
          if (!before.has("aichat") && after.has("aichat")) {
            void useChatPanelStore.getState().load(useAppStore.getState().vaultId);
          }
        }
        if (prev && layoutSig(prev) !== layoutSig(mirror)) broadcastLayout();
        // 回收已移除条目的 OS 窗口
        const removed = prev
          ? prev.detachedWindows.filter((w) => !mirror.detachedWindows.some((m) => m.id === w.id))
          : [];
        for (const w of removed) void get().closePanelWindow(w.id);
        get().syncCollabHost();
      };
      useUiStateStore.subscribe(syncFromUi);
      syncFromUi();

      // 当前打开文件 + 仓库信息广播（撕裂窗口镜像文件状态/切仓库换上下文用）
      useAppStore.subscribe((s, prev) => {
        if (
          s.vaultId !== prev.vaultId ||
          s.currentCanvasFile !== prev.currentCanvasFile ||
          s.currentNoteFile !== prev.currentNoteFile ||
          s.currentTableFile !== prev.currentTableFile ||
          s.currentNoteTitle !== prev.currentNoteTitle ||
          s.currentTableTitle !== prev.currentTableTitle
        ) {
          void bus.emitOpenFileChanged({
            vaultId: s.vaultId,
            vaultRoot: s.vaultRoot,
            vaultName: s.vaultName,
            currentCanvasFile: s.currentCanvasFile,
            currentNoteFile: s.currentNoteFile,
            currentTableFile: s.currentTableFile,
            currentNoteTitle: s.currentNoteTitle,
            currentTableTitle: s.currentTableTitle,
          });
        }
      });

      // 事件监听
      void bus.onPanelInitRequest((windowId) => {
        const ui = useUiStateStore.getState();
        const entry = ui.detachedWindows.find((w) => w.id === windowId);
        const app = useAppStore.getState();
        void bus.emitPanelInit({
          windowId,
          vaultId: app.vaultId,
          vaultRoot: app.vaultRoot,
          vaultName: app.vaultName,
          tabs: entry ? entry.tabs : [],
          activeTabId: entry ? entry.activeTabId : null,
          currentCanvasFile: app.currentCanvasFile,
          currentNoteFile: app.currentNoteFile,
          currentTableFile: app.currentTableFile,
          currentNoteTitle: app.currentNoteTitle,
          currentTableTitle: app.currentTableTitle,
        });
      });
      void bus.onPanelClosed((windowId) => {
        useUiStateStore.getState().removeDetachedWindow(windowId);
      });
      void bus.onPanelBounds((windowId, bounds) => {
        set((s) => ({ windowBounds: { ...s.windowBounds, [windowId]: bounds } }));
        useUiStateStore.getState().detachedSetBounds(windowId, bounds);
      });
      void bus.onPanelLayoutOp((windowId, op) => {
        const ui = useUiStateStore.getState();
        switch (op.op) {
          case "setActive":
            ui.detachedSetActive(windowId, op.tabId);
            break;
          case "closeTab":
            ui.detachedCloseTab(windowId, op.tabId);
            break;
          case "setLocked":
            ui.detachedSetLocked(windowId, op.tabId, op.locked);
            break;
          case "setTabView":
            ui.detachedSetTabView(windowId, op.tabId, op.view);
            break;
          case "moveTab":
            ui.detachedMoveTab(windowId, op.tabId, op.toIndex);
            break;
          case "addView":
            ui.detachedAddView(windowId, op.view);
            break;
        }
      });
      // 拖拽（外来）：记录 activeDrag（ghost 影子同源于该状态）/ 命中 / 结束解析
      void bus.onPanelDragStart((payload: PanelDragStartPayload) => {
        if (get().drag) return; // 本地拖拽进行中，忽略外来
        set({
          activeDrag: {
            tabId: payload.tabId,
            view: payload.view,
            sourceWindow: payload.sourceWindow,
            sourceHost: payload.sourceHost,
            screenX: payload.screenX,
            screenY: payload.screenY,
            seq: payload.seq,
          },
        });
      });
      void bus.onPanelDragMove(({ screenX, screenY }) => {
        computeOwnHit(screenX, screenY);
        // ghost 影子订阅 activeDrag：坐标随 move 广播推进（终点坐标以 end 广播为准，此处更新不影响落点解析）
        set((s) => (s.activeDrag ? { activeDrag: { ...s.activeDrag, screenX, screenY } } : s));
      });
      void bus.onPanelDragEnd(({ screenX, screenY, cancelled, seq }) => {
        // 落点解析仅执行一次（seq 防重：主窗口本地 finishDrag 已解析时跳过）
        if (!cancelled && seq !== lastResolvedSeq) {
          lastResolvedSeq = seq;
          resolveDrop(screenX, screenY);
        }
        set({ activeDrag: null, dropTarget: null, lastPanelTarget: null });
        // 本窗口是源且本地会话未清理（释放事件丢失由轮询/看门狗兜底广播 end）→ 结束会话
        if (get().drag?.seq === seq) set({ drag: null, dragCandidate: null });
      });
      void bus.onPanelDragTarget(({ window, target }) => {
        if (window === "main") return; // 主窗口命中由本地计算
        if (target) set({ lastPanelTarget: target });
        else set((s) => (s.lastPanelTarget?.window === window ? { lastPanelTarget: null } : s));
      });

      // 设置变化 → 协作宿主重算
      useSettingsStore.subscribe((s, prev) => {
        if (
          s.collabEnabled !== prev.collabEnabled ||
          s.collabRelayUrl !== prev.collabRelayUrl ||
          s.collabNickname !== prev.collabNickname ||
          s.collabColor !== prev.collabColor ||
          s.deviceName !== prev.deviceName
        ) {
          get().syncCollabHost();
        }
      });
      // 仓库切换（vaultId 变化）→ 协作重算
      useAppStore.subscribe((s, prev) => {
        if (s.vaultId !== prev.vaultId) get().syncCollabHost();
      });
    },

    initPanel: async () => {
      const label = getCurrentWindowLabel();
      const windowId = label.startsWith(PANEL_LABEL_PREFIX) ? label.slice(PANEL_LABEL_PREFIX.length) : label;
      set({ role: "panel", windowId });
      // 面板窗口的 uiStateStore 实例不落盘（防默认态整写覆盖主窗口 ui-state.json）
      setUiStatePersistSuppressed(true);
      try {
        const pos = await getCurrentOuterPosition();
        set({ windowPos: pos });
      } catch {
        /* 忽略 */
      }
      void onWindowMoved(() => {
        void getCurrentOuterPosition().then((pos) => set({ windowPos: pos }));
        window.setTimeout(() => void get().reportBounds(), 300);
      });

      // 首次上报 bounds（主窗口 bounds 注册表 + 拖拽命中需要）
      void get().reportBounds();

      // 握手：重试直到收到 panel-init（主窗口可能尚未就绪）
      let tries = 0;
      const tryInit = (): void => {
        if (get().panelReady) return;
        if (tries++ > 20) return;
        void bus.emitPanelInitRequest(windowId);
        window.setTimeout(tryInit, 500);
      };
      void bus.onPanelInit((payload) => {
        if (payload.windowId !== windowId) return;
        get().applyPanelInit(payload);
      });
      void bus.onLayoutChanged(({ workspaceLayouts, detachedWindows, activeLayoutId }) => {
        const entry = detachedWindows.find((w) => w.id === windowId);
        const mirror: LayoutMirror = {
          activeTree:
            workspaceLayouts.find((l) => l.id === activeLayoutId)?.tree ??
            workspaceLayouts[0].tree,
          detachedWindows,
        };
        const prev = get().layoutMirror;
        set({ layoutMirror: mirror });
        // 视图离开本窗口 → releaseView（落盘 + 清内存）；进入 → 由视图组件挂载加载
        if (prev) {
          const before = new Set(
            prev.detachedWindows.find((w) => w.id === windowId)?.tabs.map((t) => t.view) ?? [],
          );
          const after = new Set(entry?.tabs.map((t) => t.view) ?? []);
          for (const v of before) {
            if (!after.has(v)) void get().releaseView(v);
          }
        }
        set({
          panelTabs: entry ? entry.tabs : [],
          panelActiveTabId: entry ? entry.activeTabId : null,
        });
        get().syncCollabHost();
      });
      void bus.onOpenFileChanged((payload) => {
        const app = useAppStore.getState();
        useAppStore.setState({
          vaultId: payload.vaultId,
          vaultRoot: payload.vaultRoot,
          vaultName: payload.vaultName,
          currentCanvasFile: payload.currentCanvasFile,
          currentNoteFile: payload.currentNoteFile,
          currentTableFile: payload.currentTableFile,
          currentNoteTitle: payload.currentNoteTitle,
          currentTableTitle: payload.currentTableTitle,
        });
        // 切仓库：AI 会话换仓库读盘 + 协作宿主重算（仓库房间变化）
        if (payload.vaultId !== app.vaultId) {
          void useChatPanelStore.getState().load(payload.vaultId);
          get().syncCollabHost();
        }
      });
      void bus.onPanelDragMove(({ screenX, screenY }) => {
        computeOwnHit(screenX, screenY);
        // ghost 影子订阅 activeDrag：本窗口为源时非 null（随 move 推进坐标），接收外来拖拽时保持 null（不渲染）
        set((s) => (s.activeDrag ? { activeDrag: { ...s.activeDrag, screenX, screenY } } : s));
      });
      void bus.onPanelDragEnd(({ seq }) => {
        set({ dropTarget: null });
        // 本窗口是源且本地会话未清理（释放事件丢失由轮询/看门狗兜底广播 end）→ 结束会话
        if (get().drag?.seq === seq) set({ drag: null, dragCandidate: null, activeDrag: null });
      });
      tryInit();
    },

    applyPanelInit: (payload) => {
      const windowId = get().windowId;
      set({
        panelReady: true,
        panelTabs: payload.tabs,
        panelActiveTabId: payload.activeTabId,
        // 撕裂窗口不承载主窗口面板树：activeTree 用空面板（findViewHost 的「main」判定不误命中）
        layoutMirror: {
          activeTree: { kind: "panel", id: windowId, tabs: [], activeTabId: null },
          detachedWindows: payload.tabs.length
            ? [{ id: windowId, tabs: payload.tabs, activeTabId: payload.activeTabId, bounds: get().windowBounds[windowId] ?? { x: 0, y: 0, width: 0, height: 0 } }]
            : [],
        },
      });
      // 镜像仓库与文件状态
      useAppStore.setState({
        vaultId: payload.vaultId,
        vaultRoot: payload.vaultRoot,
        vaultName: payload.vaultName,
        currentCanvasFile: payload.currentCanvasFile,
        currentNoteFile: payload.currentNoteFile,
        currentTableFile: payload.currentTableFile,
        currentNoteTitle: payload.currentNoteTitle,
        currentTableTitle: payload.currentTableTitle,
      });
      // 外观与配置（主题/强调色/仓库级模型配置；撕裂窗口渲染需应用）
      void useSettingsStore.getState().load();
      if (payload.vaultId) void useSettingsStore.getState().loadVaultConfig();
      // 应用级 UI 使用状态（recentFiles 等供「最近打开」面板；撕裂窗口只读加载、不落盘——持久化已抑制）
      void useUiStateStore.getState().load();
      // AI 对话会话读盘（aichat 视图渲染依赖）
      void useChatPanelStore.getState().load(payload.vaultId);
      // 仓库文件树初载（撕裂窗口 watcher 只订阅不初载）：@ 选择器候选与 pathKind 目录标注依赖
      void useVaultStore.getState().loadFiles();
      // 窗口标题 = 激活标签
      void setWindowTitle(titleOfTabs(payload.tabs, payload.activeTabId));
      get().syncCollabHost();
    },

    reportBounds: async () => {
      try {
        const pos = await getCurrentOuterPosition();
        const size = await getCurrentOuterSize();
        const bounds = { ...pos, ...size };
        set((s) => ({ windowBounds: { ...s.windowBounds, [get().windowId]: bounds } }));
        void bus.emitPanelBounds(get().windowId, bounds);
      } catch {
        /* 忽略 */
      }
    },

    beginDragCandidate: (tab, sourceHost, pointerId, x, y) => {
      if (tab.locked) return;
      if (get().drag) return;
      set({ dragCandidate: { tab, sourceHost, pointerId, x, y } });
    },

    moveDragCandidate: (clientX, clientY) => {
      const c = get().dragCandidate;
      if (!c) return false;
      if (get().drag) return true;
      if (Math.hypot(clientX - c.x, clientY - c.y) < DRAG_THRESHOLD_PX) return false;
      // 转正：OS 鼠标按下隐式捕获保证窗口外仍收事件，置会话 + 广播
      const { windowPos, windowId } = get();
      const screenX = clientX + windowPos.x;
      const screenY = clientY + windowPos.y;
      const seq = ++dragSeqCounter;
      const session: DragSession = {
        tabId: c.tab.id,
        view: c.tab.view,
        sourceWindow: windowId,
        sourceHost: c.sourceHost,
        screenX,
        screenY,
        seq,
      };
      set({ drag: session, activeDrag: session });
      void bus.emitPanelDragStart({
        sourceWindow: windowId,
        tabId: c.tab.id,
        view: c.tab.view,
        sourceHost: c.sourceHost,
        screenX,
        screenY,
        seq,
      });
      computeOwnHit(screenX, screenY);
      armDragWatchdog();
      startMousePoll();
      return true;
    },

    updateDrag: (clientX, clientY) => {
      const drag = get().drag;
      if (!drag) return;
      const { windowPos } = get();
      const screenX = clientX + windowPos.x;
      const screenY = clientY + windowPos.y;
      set({
        drag: { ...drag, screenX, screenY },
        activeDrag: { ...drag, screenX, screenY },
      });
      void bus.emitPanelDragMove({ screenX, screenY });
      computeOwnHit(screenX, screenY);
      armDragWatchdog();
    },

    finishDrag: (clientX, clientY, cancelled) => {
      const { windowPos } = get();
      endDrag(clientX + windowPos.x, clientY + windowPos.y, cancelled);
    },

    cancelDrag: () => endDrag(null, null, true),

    panelSetActive: (tabId) => {
      const windowId = get().windowId;
      set({ panelActiveTabId: tabId });
      void setWindowTitle(titleOfTabs(get().panelTabs, tabId));
      void bus.emitPanelLayoutOp(windowId, { op: "setActive", tabId });
    },

    panelCloseTab: (tabId) => {
      const windowId = get().windowId;
      const win = get().layoutMirror?.detachedWindows.find((w) => w.id === windowId);
      const tab = win?.tabs.find((t) => t.id === tabId);
      if (!tab || tab.locked) return;
      void bus.emitPanelLayoutOp(windowId, { op: "closeTab", tabId });
    },

    panelSetLocked: (tabId, locked) => {
      const windowId = get().windowId;
      set((s) => ({
        panelTabs: s.panelTabs.map((t) => (t.id === tabId ? { ...t, locked } : t)),
      }));
      void bus.emitPanelLayoutOp(windowId, { op: "setLocked", tabId, locked });
    },

    panelSetTabView: (tabId, view) => {
      const windowId = get().windowId;
      // 视图交接：原视图（canvas/table/aichat）跨标签切换后不再承载，先 flush/清内存态
      const tab = get().panelTabs.find((t) => t.id === tabId);
      if (!tab || tab.locked) return;
      if (tab.view !== view) void get().releaseView(tab.view);
      void bus.emitPanelLayoutOp(windowId, { op: "setTabView", tabId, view });
    },

    panelMoveTab: (tabId, toIndex) => {
      const windowId = get().windowId;
      void bus.emitPanelLayoutOp(windowId, { op: "moveTab", tabId, toIndex });
    },

    panelAddView: (view) => {
      const windowId = get().windowId;
      void bus.emitPanelLayoutOp(windowId, { op: "addView", view });
    },

    releaseView: async (view) => {
      try {
        switch (view) {
          case "canvas":
            await useCanvasStore.getState().flush();
            useCanvasStore.getState().resetCanvasState();
            break;
          case "table":
            await useTableStore.getState().flush();
            useTableStore.getState().clear();
            break;
          case "aichat":
            await useChatPanelStore.getState().flush(useAppStore.getState().vaultId);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error(`释放视图 ${view} 落盘失败`, e);
      }
    },

    syncCollabHost: () => {
      const st = useSettingsStore.getState();
      const collab = useCollabStore.getState();
      if (!st.collabEnabled) {
        if (collab.connected) collab.dispose();
        return;
      }
      const mirror = get().layoutMirror;
      if (!mirror) return;
      // 协作宿主 = 本窗口渲染了协作相关视图才连接（每个窗口独立持有连接）：
      // 画布/笔记/表格显示远端 presence，协作房间面板本身也需要在线成员列表
      const relevant: ViewKind[] = ["canvas", "table", "note", "collabroom"];
      const isHost = relevant.some(
        (v) => findViewHost(mirror.activeTree, mirror.detachedWindows, v) === get().windowId,
      );
      if (isHost && !collab.connected) {
        collab.init({
          enabled: true,
          url: st.collabRelayUrl,
          nickname: st.collabNickname,
          color: st.collabColor,
          deviceName: st.deviceName,
        });
      } else if (!isHost && collab.connected) {
        collab.dispose();
      }
    },

    restoreDetachedWindows: async () => {
      const windows = useUiStateStore.getState().detachedWindows;
      for (const w of windows) {
        if (get().createdPanels.has(w.id)) continue;
        get().createdPanels.add(w.id);
        const ok = await createPanelWindow(w.id, titleOfTabs(w.tabs, w.activeTabId), w.bounds);
        if (!ok) {
          get().createdPanels.delete(w.id);
          console.error(`恢复撕裂窗口失败：${w.id}`);
        }
      }
    },

    tearOff: async (panelId, tabId, screenX, screenY) => {
      const drag = get().activeDrag;
      const view = drag?.tabId === tabId ? drag.view : undefined;
      if (view) await get().releaseView(view);
      const bounds = boundsNear(screenX, screenY);
      const win = useUiStateStore.getState().tearOffTab(panelId, tabId, bounds);
      if (!win) return;
      get().createdPanels.add(win.id);
      await createPanelWindow(win.id, titleOfTabs(win.tabs, win.activeTabId), win.bounds);
    },

    tearOffFromPanel: async (sourceWindowId, tabId, screenX, screenY) => {
      const bounds = boundsNear(screenX, screenY);
      const win = useUiStateStore.getState().tearOffFromDetached(sourceWindowId, tabId, bounds);
      if (!win) return;
      get().createdPanels.add(win.id);
      await createPanelWindow(win.id, titleOfTabs(win.tabs, win.activeTabId), win.bounds);
    },

    closePanelWindow: async (windowId) => {
      await closeWindowByLabel(`${PANEL_LABEL_PREFIX}${windowId}`);
      get().createdPanels.delete(windowId);
    },
  };
});
