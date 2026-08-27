/**
 * 跨窗口事件总线（多窗口面板体系的 Tauri event 封装，纯 I/O，无状态）。
 *
 * 事件协议（全部 app 级广播；Rust watcher 已用 app.emit 全窗口可达，本文件定义面板私有事件）：
 * - `panel-init-request` / `panel-init`：撕裂窗口启动握手（panel → main / main → panel）
 * - `panel-closed`：撕裂窗口关闭前上报（panel → main，主窗口据此移除持久化条目）
 * - `layout-changed`：主窗口布局/撕裂窗口变更广播（main → all；撕裂窗口据此刷新镜像与视图归属）
 * - `open-file-changed`：当前打开文件广播（main → all；撕裂窗口据此镜像文件状态、承载视图自动加载）
 * - `panel-bounds`：窗口位置尺寸上报（各窗口 → all；主窗口维护 bounds 注册表 + 防抖持久化）
 * - `panel-layout-op`：撕裂窗口本地操作请求（panel → main，布局权威在主窗口）
 * - `panel-drag-start/move/end`：跨窗口拖拽会话（源窗口 → all；屏幕坐标）
 * - `panel-drag-target`：命中窗口上报目标区（各窗口 → all；主窗口在 drag-end 据此应用布局操作）
 */
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TabItem, ViewKind } from "@/types";

/** 窗口位置尺寸（logical px）。 */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** drop 区类型：center = 加标签；left/right/top/bottom = 分割（主窗口面板）；tab = 标签条排序。 */
export type DropZone = "center" | "left" | "right" | "top" | "bottom" | "tab";

/** 一次命中的 drop 目标（本窗口计算，广播给主窗口在 drag-end 应用）。 */
export interface DropTargetInfo {
  /** 目标窗口 label（"main" 或 panel label）。 */
  window: string;
  /** 主窗口面板 id（撕裂窗口命中时为 undefined）。 */
  panelId?: string;
  zone: DropZone;
  /** zone = tab 时的插入位置（目标标签组内下标）。 */
  tabIndex?: number;
}

/** panel-init 载荷：撕裂窗口渲染所需的最小上下文（仓库信息 + 自身标签组 + 当前文件镜像）。 */
export interface PanelInitPayload {
  windowId: string;
  vaultId: string | null;
  vaultRoot: string | null;
  vaultName: string;
  tabs: TabItem[];
  activeTabId: string | null;
  currentCanvasFile: string | null;
  currentNoteFile: string | null;
  currentTableFile: string | null;
  currentNoteTitle: string;
  currentTableTitle: string;
}

/** 撕裂窗口本地操作请求（布局权威在主窗口，主窗口应用后广播 layout-changed）。 */
export type PanelLayoutOp =
  | { op: "setActive"; tabId: string }
  | { op: "closeTab"; tabId: string }
  | { op: "setLocked"; tabId: string; locked: boolean }
  | { op: "setTabView"; tabId: string; view: ViewKind }
  | { op: "moveTab"; tabId: string; toIndex: number }
  | { op: "addView"; view: ViewKind };

export interface PanelDragStartPayload {
  sourceWindow: string;
  tabId: string;
  view: ViewKind;
  /** 源宿主：主窗口面板 id 或撕裂窗口 id。 */
  sourceHost: string;
  screenX: number;
  screenY: number;
  /** 拖拽会话序号（end 广播防重解析用）。 */
  seq: number;
}

export interface PanelDragMovePayload {
  screenX: number;
  screenY: number;
}

export interface PanelDragEndPayload {
  sourceWindow: string;
  screenX: number;
  screenY: number;
  cancelled: boolean;
  /** 拖拽会话序号（与 drag-start 对应）。 */
  seq: number;
}

export interface PanelDragTargetPayload {
  /** 发送窗口（"main" 或 panel label）。 */
  window: string;
  target: DropTargetInfo | null;
}

export interface OpenFileChangedPayload {
  vaultId: string | null;
  vaultRoot: string | null;
  vaultName: string;
  currentCanvasFile: string | null;
  currentNoteFile: string | null;
  currentTableFile: string | null;
  currentNoteTitle: string;
  currentTableTitle: string;
}

export interface LayoutChangedPayload {
  workspaceLayouts: import("@/types/workspaceLayout").WorkspaceLayout[];
  detachedWindows: import("@/types/workspaceLayout").DetachedWindow[];
  activeLayoutId: string | null;
}

// ---------- emit ----------

export function emitPanelInitRequest(windowId: string): Promise<void> {
  return emit("panel-init-request", { windowId });
}

export function emitPanelInit(payload: PanelInitPayload): Promise<void> {
  return emit("panel-init", payload);
}

export function emitPanelClosed(windowId: string): Promise<void> {
  return emit("panel-closed", { windowId });
}

export function emitLayoutChanged(payload: LayoutChangedPayload): Promise<void> {
  return emit("layout-changed", payload);
}

export function emitOpenFileChanged(payload: OpenFileChangedPayload): Promise<void> {
  return emit("open-file-changed", payload);
}

export function emitPanelBounds(windowId: string, bounds: WindowRect): Promise<void> {
  return emit("panel-bounds", { windowId, bounds });
}

export function emitPanelLayoutOp(windowId: string, op: PanelLayoutOp): Promise<void> {
  return emit("panel-layout-op", { windowId, op });
}

export function emitPanelDragStart(payload: PanelDragStartPayload): Promise<void> {
  return emit("panel-drag-start", payload);
}

export function emitPanelDragMove(payload: PanelDragMovePayload): Promise<void> {
  return emit("panel-drag-move", payload);
}

export function emitPanelDragEnd(payload: PanelDragEndPayload): Promise<void> {
  return emit("panel-drag-end", payload);
}

export function emitPanelDragTarget(payload: PanelDragTargetPayload): Promise<void> {
  return emit("panel-drag-target", payload);
}

// ---------- listen ----------

export function onPanelInitRequest(
  handler: (windowId: string) => void,
): Promise<UnlistenFn> {
  return listen<{ windowId: string }>("panel-init-request", (e) => handler(e.payload.windowId));
}

export function onPanelInit(handler: (payload: PanelInitPayload) => void): Promise<UnlistenFn> {
  return listen<PanelInitPayload>("panel-init", (e) => handler(e.payload));
}

export function onPanelClosed(handler: (windowId: string) => void): Promise<UnlistenFn> {
  return listen<{ windowId: string }>("panel-closed", (e) => handler(e.payload.windowId));
}

export function onLayoutChanged(handler: (payload: LayoutChangedPayload) => void): Promise<UnlistenFn> {
  return listen<LayoutChangedPayload>("layout-changed", (e) => handler(e.payload));
}

export function onOpenFileChanged(handler: (payload: OpenFileChangedPayload) => void): Promise<UnlistenFn> {
  return listen<OpenFileChangedPayload>("open-file-changed", (e) => handler(e.payload));
}

export function onPanelBounds(
  handler: (windowId: string, bounds: WindowRect) => void,
): Promise<UnlistenFn> {
  return listen<{ windowId: string; bounds: WindowRect }>("panel-bounds", (e) =>
    handler(e.payload.windowId, e.payload.bounds),
  );
}

export function onPanelLayoutOp(
  handler: (windowId: string, op: PanelLayoutOp) => void,
): Promise<UnlistenFn> {
  return listen<{ windowId: string; op: PanelLayoutOp }>("panel-layout-op", (e) =>
    handler(e.payload.windowId, e.payload.op),
  );
}

export function onPanelDragStart(handler: (payload: PanelDragStartPayload) => void): Promise<UnlistenFn> {
  return listen<PanelDragStartPayload>("panel-drag-start", (e) => handler(e.payload));
}

export function onPanelDragMove(handler: (payload: PanelDragMovePayload) => void): Promise<UnlistenFn> {
  return listen<PanelDragMovePayload>("panel-drag-move", (e) => handler(e.payload));
}

export function onPanelDragEnd(handler: (payload: PanelDragEndPayload) => void): Promise<UnlistenFn> {
  return listen<PanelDragEndPayload>("panel-drag-end", (e) => handler(e.payload));
}

export function onPanelDragTarget(handler: (payload: PanelDragTargetPayload) => void): Promise<UnlistenFn> {
  return listen<PanelDragTargetPayload>("panel-drag-target", (e) => handler(e.payload));
}
