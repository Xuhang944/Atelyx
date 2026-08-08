/**
 * 弹层菜单关闭交互：Esc 关闭 + 点击菜单外关闭（pointerdown 监听——树行/表行的
 * pointerdown 会 preventDefault 抑制 mousedown 派发，用 pointerdown 才能可靠捕获）。
 * 返回 menuRef 挂到菜单容器（容器内元素需自行 stopPropagation，防点按钮被抢先关闭）。
 *
 * 挂载期间监听、卸载清理；onClose 用 ref 存最新回调，监听不随每次渲染重绑。
 * 字段菜单 / 行菜单 / 添加字段浮层等弹层共用（原三处手写重复代码收敛至此）。
 */
import { useEffect, useRef } from "react";

export function useDismissOnOutside(onClose: () => void) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
    // menuRef 为稳定引用（hook 内 useRef），加入依赖仅为消除 exhaustive-deps，不会重挂监听
  }, [menuRef]);

  return menuRef;
}
