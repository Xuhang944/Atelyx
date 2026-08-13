/**
 * Agent 模式开关按钮组（画布对话节点 / AI 对话面板共用）：
 * Bot 按钮点击切换模式（普通对话 ↔ 工具调用）；开启时旁侧小箭头弹出工具勾选浮层。
 *
 * 浮层与 `DropdownSelect` 同款弹层机制（锚定按钮 + portal + 钳制，见 AgentToolsMenu）：
 * trigger 的 pointerdown 阻止冒泡（防浮层的「点击外部关闭」误关自身，toggle 语义归 click）。
 * 差异由 props 表达：状态来源（节点 .atlx vs 面板内存态）与按钮样式由调用方注入。
 */
import { useRef, useState, type MouseEvent } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { AgentToolsMenu } from "@/components/common/AgentToolsMenu";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    minWidth: number;
  } | null>(null);

  const onTriggerClick = () => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom + 2, minWidth: r.width });
  };

  return (
    <>
      <div className="flex items-center nodrag">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            // 切换模式即收起工具浮层（开/关都关）
            setAnchor(null);
            onToggleMode();
          }}
          title={
            agentMode
              ? "Agent 模式：已开启（AI 可自主调用工具）"
              : "Agent 模式：关闭（普通对话，点击开启）"
          }
          aria-label="Agent 模式"
          // pointerdown 阻止冒泡：浮层的「点击外部关闭」监听在 document，不拦会触发自身关闭
          onPointerDown={(e: MouseEvent) => e.stopPropagation()}
          className={`flex items-center rounded px-1 py-0.5 hover:opacity-80 ${className ?? ""}`}
          style={{ color: agentMode ? "var(--accent)" : "var(--text-muted)" }}
        >
          <Bot size={13} className="flex-shrink-0" />
        </button>
        {agentMode && (
          <button
            type="button"
            onClick={onTriggerClick}
            title="选择启用的工具"
            aria-label="Agent 工具设置"
            onPointerDown={(e: MouseEvent) => e.stopPropagation()}
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
        onClose={() => setAnchor(null)}
      />
    </>
  );
}
