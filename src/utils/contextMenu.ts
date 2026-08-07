/**
 * 右键菜单位置钳制：菜单 fixed 定位在鼠标坐标处，靠近窗口右/下边缘时会超出视口被截断，
 * 此处把位置收敛到视口内（必要时上翻/左翻；菜单比视口还大时贴边兜底）。
 * 调用时机：菜单挂载后按实测尺寸调用（useLayoutEffect，paint 前调整无闪烁）。
 */
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  gap = 6,
): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.min(Math.max(x, gap), Math.max(gap, vw - w - gap)),
    y: Math.min(Math.max(y, gap), Math.max(gap, vh - h - gap)),
  };
}
