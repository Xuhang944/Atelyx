/**
 * 当前窗口控制 service（decorations: false 自定义标题栏/全屏用）。
 */
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

/** 启动页窗口尺寸（固定、不可调整）。 */
const STARTUP_WINDOW = { width: 960, height: 640 };
/** 工作区窗口尺寸（默认与最小一致：不可缩小到默认以下）。 */
const WORKSPACE_WINDOW = { width: 1440, height: 900 };

/** 调整尺寸并按当前显示器居中（center 基于显示器几何计算，不读窗口旧位置——
 * 多次调用幂等、无累积漂移；替代「读当前位置再写回」的按中心调整，后者在 Windows 上
 * setPosition 异步应用、outerPosition 读回旧值，连续调用会向右下漂移）。 */
async function setSizeCentered(win: Window, width: number, height: number): Promise<void> {
  await win.setSize(new LogicalSize(width, height));
  await win.center();
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
  // 首启时窗口已按启动页尺寸居中创建，此调用为 no-op；从工作区返回时才真正收缩居中
  await setSizeCentered(win, STARTUP_WINDOW.width, STARTUP_WINDOW.height);
}

/** 进入工作区：恢复可调整；窗口小于默认时放大到默认；最小尺寸 = 默认（不可缩小）。 */
export async function applyWorkspaceWindow(): Promise<void> {
  const win = getCurrentWindow();
  await win.setResizable(true);
  const minSize = new LogicalSize(WORKSPACE_WINDOW.width, WORKSPACE_WINDOW.height);
  if (await win.isMaximized()) {
    // 最大化时跳过 resize（防强制放大跳变），但最小尺寸约束仍要设：
    // 否则取消最大化后窗口停在小尺寸且无约束（加载屏期间手动最大化 + 自动进工作区的唯一触发路径）
    await win.setMinSize(minSize);
    return;
  }
  const logical = (await win.outerSize()).toLogical(await win.scaleFactor());
  if (logical.width < WORKSPACE_WINDOW.width || logical.height < WORKSPACE_WINDOW.height) {
    await setSizeCentered(win, WORKSPACE_WINDOW.width, WORKSPACE_WINDOW.height);
  }
  // 先 resize 再设最小尺寸：窗口已到默认尺寸，setMinSize 不触发强制拉大
  // （Windows 上 min > 当前尺寸会立即左上锚定放大，导致跳变）
  await win.setMinSize(minSize);
}
