/**
 * Agent 模式开关按钮组（画布对话节点 / AI 对话面板共用）：
 * Bot 按钮点击切换模式（普通对话 ↔ 工具调用）；开启时旁侧小箭头弹出工具勾选浮层。
 *
 * 浮层 = `PopupLayer` 统一壳（锚定箭头按钮 + portal + 钳制/向上翻转 +
 * triggerRef 排除自身按钮组区域）。trigger 不再 stopPropagation——外点关闭由
 * PopupLayer 的 triggerRef 排除处理，点本按钮时 pointerdown 仍能到 document，
 * 其它弹层（如提示词/模型下拉）打开时点本按钮能正常关闭它们（全项目浮层互斥）。
 */
import { useRef } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { AgentToolsMenu } from "@/components/common/AgentToolsMenu";
import { usePopupAnchor } from "@/hooks/usePopupAnchor";

interface AgentModeToggleProps {
  /** 是否开启 Agent 模式（accent 高亮态）。 */
  agentMode: boolean;
  onToggleMode: () => void;
  /** 当前启用的工具 id（缺省 = 全部启用）。 */
  enabledTools: string[];
  onToggleTool: (id: string, enabled: boolean) => void;
  /** 触发按钮样式（节点紧凑 / 面板宽松差异）。 */
  className?: string;
}

export function AgentModeToggle({
  agentMode,
  onToggleMode,
  enabledTools,
  onToggleTool,
  className,
}: AgentModeToggleProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const { anchor, toggle, close } = usePopupAnchor(chevronRef);

  return (
    <>
      <div ref={wrapperRef} className="flex items-center nodrag">
        <button
          type="button"
          onClick={() => {
            // 切换模式即收起工具浮层（开/关都关）
            close();
            onToggleMode();
          }}
          title={
            agentMode
              ? "Agent 模式：已开启（AI 可自主调用工具）"
              : "Agent 模式：关闭（普通对话，点击开启）"
          }
          aria-label="Agent 模式"
          className={`flex items-center rounded px-1 py-0.5 hover:opacity-80 ${className ?? ""}`}
          style={{ color: agentMode ? "var(--accent)" : "var(--text-muted)" }}
        >
          <Bot size={13} className="flex-shrink-0" />
        </button>
        {agentMode && (
          <button
            ref={chevronRef}
            type="button"
            onClick={toggle}
            title="选择启用的工具"
            aria-label="Agent 工具设置"
            className="rounded px-0.5 py-0.5 hover:opacity-80 -ml-1"
            style={{ color: "var(--text-muted)" }}
          >
            <ChevronDown size={11} className="flex-shrink-0" />
          </button>
        )}
      </div>
      <AgentToolsMenu
        anchor={anchor}
        enabled={enabledTools}
        onToggle={onToggleTool}
        onClose={close}
        triggerRef={wrapperRef}
      />
    </>
  );
}
