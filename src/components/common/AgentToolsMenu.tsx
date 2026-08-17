/**
 * Agent 工具设置浮层（画布对话节点 / AI 对话面板共用）：列出全部工具 checkbox 供勾选（缺省全开）。
 * 弹层 = `PopupLayer` 统一壳（锚定触发按钮 + portal + 钳制/向上翻转 + 外点关闭排除自身 trigger 区域——
 * 点 AgentModeToggle 自身按钮不关，开/关 toggle 语义由 trigger 的 click 控制，与全项目浮层一致）。
 */
import { Check } from "lucide-react";
import type { RefObject } from "react";
import { PopupLayer, type PopupAnchor } from "@/components/common/PopupLayer";
import { AGENT_TOOLS_META } from "@/constants/tools";

interface AgentToolsMenuProps {
  anchor: PopupAnchor | null;
  /** 当前启用的工具 id（缺省 = 全部启用）。 */
  enabled?: string[];
  onToggle: (id: string, enabled: boolean) => void;
  onClose: () => void;
  /** 自身 trigger 区域（AgentModeToggle 按钮组）：外点排除，toggle 语义归 trigger click。 */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function AgentToolsMenu({
  anchor,
  enabled,
  onToggle,
  onClose,
  triggerRef,
}: AgentToolsMenuProps) {
  if (!anchor) return null;
  const active = enabled ?? AGENT_TOOLS_META.map((t) => t.id);
  return (
    <PopupLayer
      anchor={anchor}
      onClose={onClose}
      triggerRef={triggerRef}
      zClass="z-[1100]"
      widthClass="w-44"
      contentClassName="p-1"
    >
      {AGENT_TOOLS_META.map((t) => {
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
    </PopupLayer>
  );
}
