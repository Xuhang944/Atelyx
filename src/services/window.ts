/**
 * 当前窗口控制 service（decorations: false 自定义标题栏/全屏用）。
 */
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

/** 启动页窗口尺寸（固定、不可调整）。 */
const STARTUP_WINDOW = { width: 960, height: 640 };
/** 工作区窗口尺寸（默认与最小一致：不可缩小到默认以下）。 */
const WORKSPACE_WINDOW = { width: 1440, height: 900 };

/** 以当前窗口中心为基准调整到目标尺寸（先移位置再改尺寸，中心点不动、四周对称变化）。 */
async function resizeAroundCenter(win: Window, width: number, height: number): Promise<void> {
  const scale = await win.scaleFactor();
  const pos = (await win.outerPosition()).toLogical(scale);
  const size = (await win.outerSize()).toLogical(scale);
  const cx = pos.x + size.width / 2;
  const cy = pos.y + size.height / 2;
  await win.setPosition(new LogicalPosition(cx - width / 2, cy - height / 2));
  await win.setSize(new LogicalSize(width, height));
}

/** 最小化当前窗口。 */
export function minimizeWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

/** 最大化 / 还原当前窗口。 */
export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

/** 关闭当前窗口。 */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

/** 切换全屏（视图控制图标用）。 */
export async function toggleFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  const fs = await win.isFullscreen();
  await win.setFullscreen(!fs);
}

/** 进入启动页：退出全屏/最大化 → 移除最小尺寸约束 → 固定尺寸且不可调整（内容自适应）。 */
export async function applyStartupWindow(): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isFullscreen()) await win.setFullscreen(false);
  if (await win.isMaximized()) await win.unmaximize();
  await win.setMinSize(null);
  await win.setResizable(false);
  await resizeAroundCenter(win, STARTUP_WINDOW.width, STARTUP_WINDOW.height);
}

/** 进入工作区：恢复可调整并设最小尺寸 = 默认（1440×900，不可缩小）；窗口小于默认时放大到默认。 */
export async function applyWorkspaceWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.setResizable(true);
  await win.setMinSize(new LogicalSize(WORKSPACE_WINDOW.width, WORKSPACE_WINDOW.height));
  if (await win.isMaximized()) return;
  const logical = (await win.outerSize()).toLogical(await win.scaleFactor());
  if (logical.width < WORKSPACE_WINDOW.width || logical.height < WORKSPACE_WINDOW.height) {
    await resizeAroundCenter(win, WORKSPACE_WINDOW.width, WORKSPACE_WINDOW.height);
  }
}

/** 显示当前窗口（启动时窗口隐藏，初始化完成后显示，避免非首启先闪启动页）。 */
export function showWindow(): Promise<void> {
  return getCurrentWindow().show();
}
