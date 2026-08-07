/**
 * 消息气泡内的「思考过程」折叠块（reasoning_content 展示）。
 * 默认折叠；折叠且仍在流式时标题带强调色扫光等待动画，完成后静止。
 * 思考仅作即时过程展示：不进 API 历史上下文、不参与复制。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function ThinkingBlock({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="mb-1.5 rounded border-l-2 pl-2 text-xs"
      style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center gap-1 w-full text-left select-none leading-4 py-0.5"
        style={{ color: "var(--text-muted)" }}
      >
        {streaming && !open && <span className="thinking-sweep-bar" aria-hidden />}
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0" />
        )}
        <span>思考过程</span>
      </button>
      {open && (
        <div
          className="whitespace-pre-wrap break-words mt-1 max-h-48 overflow-y-auto"
          style={{ color: "var(--text-secondary)" }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
