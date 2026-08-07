import { useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition } from "@/utils/contextMenu";

/**
 * 右键/弹层菜单的视口钳制 hook：菜单 fixed 定位在鼠标坐标，挂载后按实测尺寸
 * （offsetWidth/offsetHeight）钳制到视口内，防靠近窗口右/下边缘被截断；
 * useLayoutEffect 在 paint 前调整无闪烁。
 *
 * `deps` 用于内容尺寸变化的场景：如删除确认态切换会改变菜单高度，贴视口底部时
 * 需重新钳制（依赖缺省 = 仅坐标变化时重算）。
 */
export function useClampedMenuPosition(
  x: number,
  y: number,
  deps: unknown[] = [],
) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(clampMenuPosition(x, y, el.offsetWidth, el.offsetHeight));
    // deps 由调用方显式传入（如删除确认态改变菜单高度需重新钳制），spread 后无法静态校验，属有意为之
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...deps]);
  return { ref, pos };
}
