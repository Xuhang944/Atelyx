/**
 * @提及 输入框（画布对话节点 / AI 对话面板共用）。
 *
 * 透明 textarea 承载输入（文本即真相），overlay 渲染 @引用标签 为视觉装饰层，
 * 滚动同步（transform 位移）、光标紧贴标签末尾 Backspace 整段删除（取消引用）内置。
 * 差异由 props 表达：背景层/class/占位/其他键处理（@picker 打开、Enter 发送）。
 *
 * 注意（标签对齐前提）：overlay 与 textarea 共用 INPUT_FONT——CSS 未给 textarea
 * 设 font 时 UA 默认不同会导致标签错位；@标签 只加背景 + 内阴影描边，不加
 * padding/border/nowrap（inline 元素撑高行盒会与 textarea 原始文本布局错位）。
 */
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { MentionSeg } from "@/utils/text";

/** overlay 与 textarea 严格一致的字体（CSS 未给 textarea 设 font，UA 默认不同会导致标签错位） */
export const INPUT_FONT: CSSProperties = {
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 14,
  lineHeight: "1.4rem",
};

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** 输入框分段（@提及 → 标签段，其余普通文本段）。 */
  segments: MentionSeg[];
  /** 光标紧贴 @标签 末尾退格 → 整段删除并取消引用（调用方实现断边/移出 mentions 等）。 */
  onRemoveMention: (seg: MentionSeg) => void;
  placeholder: string;
  rows?: number;
  /** 调用方持有的 textarea 引用（光标定位/焦点恢复用）。 */
  textareaRef?: RefObject<HTMLTextAreaElement>;
  /** 其他按键处理（画布 = @picker 打开坐标计算 + Enter 发送；面板 = Enter 发送）。 */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** 容器额外 class（画布 = flex-1 min-w-0 overflow-hidden；面板空）。 */
  containerClassName?: string;
  /** overlay 额外 class（含 padding/字体大小，与 textarea 对齐）。 */
  overlayClassName?: string;
  /** textarea 额外 class（含 padding/字体大小/焦点样式）。 */
  textareaClassName?: string;
  /** 输入区底色层（画布 = input-bg 背景 div；面板自带背景）。 */
  backgroundLayer?: ReactNode;
  spellCheck?: boolean;
}

/** @提及 输入框：透明 textarea + @标签 overlay（滚动同步 + Backspace 整删内置）。 */
export function MentionTextarea({
  value,
  onChange,
  segments,
  onRemoveMention,
  placeholder,
  rows,
  textareaRef,
  onKeyDown,
  onPaste,
  containerClassName,
  overlayClassName,
  textareaClassName,
  backgroundLayer,
  spellCheck,
}: MentionTextareaProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  return (
    <div className={`relative ${containerClassName ?? ""}`}>
      {backgroundLayer}
      {/* 渲染层：@提及 标签（强调色系）+ 普通文本；滚动与 textarea 同步（transform 位移） */}
      <div
        ref={overlayRef}
        aria-hidden
        className={`absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words ${overlayClassName ?? ""}`}
        style={{ ...INPUT_FONT, color: "var(--text-primary)" }}
      >
        {segments.map((s, i) =>
          s.mention ? (
            <span
              key={i}
              className="inline rounded"
              style={{
                background: "color-mix(in srgb, var(--accent) 22%, transparent)",
                boxShadow: "inset 0 0 0 1px var(--accent)",
                color: "var(--accent)",
              }}
            >
              {s.mention.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // 光标紧贴 @引用标签 末尾按退格 → 整段删除标签并取消引用（替代悬浮 X 删除按钮）
          if (e.key === "Backspace") {
            const cursor = textareaRef?.current?.selectionStart ?? 0;
            const seg = segments.find((s) => s.mention && s.start + s.text.length === cursor);
            if (seg) {
              e.preventDefault();
              onRemoveMention(seg);
              return;
            }
          }
          onKeyDown?.(e);
        }}
        onScroll={(e) => {
          // overlay 与 textarea 滚动同步（直接改 DOM，避免滚动触发重渲染）
          if (overlayRef.current) {
            overlayRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
          }
        }}
        onPaste={onPaste}
        spellCheck={spellCheck}
        placeholder={placeholder}
        rows={rows}
        className={`resize-none outline-none ${textareaClassName ?? ""}`}
        style={{
          ...INPUT_FONT,
          background: "transparent",
          color: "transparent",
          caretColor: "var(--text-primary)",
        }}
      />
    </div>
  );
}
