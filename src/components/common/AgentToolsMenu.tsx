/**
 * Agent 工具设置浮层（画布对话节点 / AI 对话面板共用）：
 * 列出全部工具 checkbox 供勾选（缺省全开）。
 *
 * 弹层机制与 `DropdownSelect` 完全一致：锚定触发按钮左下角（anchor = trigger 的
 * getBoundingClientRect）+ `createPortal` 挂 body + `useClampedMenuPosition` 视口钳制
 * （面板贴底自动上移）+ z-[1100]。portal 必须——画布节点在 React Flow transform 容器内，
 * fixed 会被 transform 祖先捕获错位（DropdownSelect 同款踩坑）。
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { AGENT_TOOLS } from "@/constants/tools";

/** 触发按钮锚定（DropdownSelect 同款：按钮左下角 + 最小宽度）。 */
export interface MenuAnchor {
  x: number;
  y: number;
  minWidth: number;
}

interface AgentToolsMenuProps {
  anchor: MenuAnchor | null;
  /** 当前启用的工具 id（缺省 = 全部启用） */
  enabled?: string[];
  onToggle: (id: string, enabled: boolean) => void;
  onClose: () => void;
}

export function AgentToolsMenu({
  anchor,
  enabled,
  onToggle,
  onClose,
}: AgentToolsMenuProps) {
  const { ref, pos } = useClampedMenuPosition(anchor?.x ?? 0, anchor?.y ?? 0);
  // Esc / 点击浮层外关闭（trigger 的 pointerdown 由 AgentModeToggle stopPropagation 拦掉，
  // 不经过此处；toggle 开关语义由 trigger 的 click 控制）
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
    // ref 为 useRef 稳定对象，加依赖无害（effect 仅随 onClose 重跑）
  }, [onClose, ref]);

  if (!anchor) return null;
  const active = enabled ?? AGENT_TOOLS.map((t) => t.id);
  return createPortal(
    <div
      ref={ref}
      className="fixed border rounded shadow-lg p-1 z-[1100] w-44"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth: anchor.minWidth,
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {AGENT_TOOLS.map((t) => {
        const on = active.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onToggle(t.id, !on)}
            className="w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 hover:bg-[var(--hover)]"
            style={{ color: on ? "var(--accent)" : "var(--text-secondary)" }}
          >
            <span
              className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
              style={{
                borderColor: on ? "var(--accent)" : "var(--border)",
                background: on ? "var(--accent)" : "transparent",
              }}
            >
              {on && <Check size={10} style={{ color: "var(--accent-fg)" }} />}
            </span>
            {t.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
