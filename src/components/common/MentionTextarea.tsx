/**
 * @提及 输入框（画布对话节点 / AI 对话面板共用）。
 *
 * 透明 textarea 承载输入（文本即真相），overlay 渲染 @引用标签 为视觉装饰层，
 * 滚动同步（transform 位移）、胶囊整体化交互内置：
 * - 点击胶囊 → 原生选中胶囊全文（金色高亮，.mention-input::selection）
 * - 选中态 Backspace/Delete、光标紧贴胶囊末尾 Backspace/开头 Delete → 整删胶囊（含两侧空格）
 * - 选中态输入字符 → 胶囊被替换，引用层同步清理（onChange 检测文本消失补调 onRemoveMention）
 * - ←/→ 光标在胶囊内/边界 → 整体跳到对侧边界（不逐字经过）
 * 文本删除统一由本组件负责（mentionRemoveRange），onRemoveMention 只做引用层清理（断边/清映射）。
 * 差异由 props 表达：背景层/class/占位/其他键处理（@picker 打开、Enter 发送）。
 *
 * 注意（标签对齐前提）：overlay 与 textarea 共用 INPUT_FONT——CSS 未给 textarea
 * 设 font 时 UA 默认不同会导致标签错位；@标签 span 本体必须保持文本宽（padding/宽度
 * 变化会使其后文本与 textarea 光标错位），视觉胶囊由 .mention-capsule 的背景 +
 * box-shadow 外扩绘制（不占布局、逐行段渲染跨行正确，见 styles/index.css）。
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
  /** 胶囊被移除（退格/Del/输入替换）→ 引用层清理（断边/移出 mentions/托盘），文本删除由本组件负责。 */
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

/** @提及 输入框：透明 textarea + @标签 overlay（滚动同步 + 胶囊整体化交互内置）。 */
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

  /** 整删胶囊 + 引用层清理；光标复位到删除点。
   * seg 来自 splitMentions（已吞两侧装饰空格），直接按段范围删除——不二次扩展
   * （mentionRemoveRange 仅给按原始命中删除的路径用，防双空格场景多删）。
   * 引用清理在此显式按段身份调用（精确，不依赖 onChange 文本检测——同名相邻段会误判）。 */
  const removeMentionAt = (seg: MentionSeg) => {
    onChange(value.slice(0, seg.start) + value.slice(seg.start + seg.text.length));
    onRemoveMention(seg);
    requestAnimationFrame(() => {
      const ta = textareaRef?.current;
      if (ta) ta.setSelectionRange(seg.start, seg.start);
    });
  };

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
            <span key={i} className="mention-capsule">
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          const newValue = e.target.value;
          // 原生输入路径（选中替换/拖选删除）导致胶囊文本消失 → 引用层兜底清理。
          // 注意：removeMentionAt 走 props onChange 不经此处，其引用清理已显式精确完成
          for (const s of segments) {
            if (s.mention && value.includes(s.text) && !newValue.includes(s.text)) {
              onRemoveMention(s);
            }
          }
          onChange(newValue);
        }}
        onKeyDown={(e) => {
          // IME 组合期间键是「上屏候选词」操作，不拦截
          if (e.nativeEvent.isComposing) {
            onKeyDown?.(e);
            return;
          }
          const ta = textareaRef?.current;
          const caret = ta?.selectionStart ?? 0;
          const selEnd = ta?.selectionEnd ?? caret;
          const selected = selEnd > caret;
          // 与光标/选中区相关的胶囊（选中态 = 相交；光标态 = 在胶囊内/边界）
          const seg = segments.find((s) => {
            if (!s.mention) return false;
            const segEnd = s.start + s.text.length;
            if (selected) return caret < segEnd && selEnd > s.start;
            return caret >= s.start && caret <= segEnd;
          });
          if (seg) {
            const segEnd = seg.start + seg.text.length;
            if (e.key === "Backspace" || e.key === "Delete") {
              if (selected) {
                // 选区恰等于胶囊范围 → 整删胶囊；跨胶囊/含其他文本的选区 → 放行原生删除整个选区
                // （引用清理由 onChange 兜底检测完成）
                if (caret === seg.start && selEnd === segEnd) {
                  e.preventDefault();
                  removeMentionAt(seg);
                  return;
                }
              } else if (
                (e.key === "Backspace" && caret === segEnd) ||
                (e.key === "Delete" && caret === seg.start)
              ) {
                e.preventDefault();
                removeMentionAt(seg);
                return;
              }
            } else if (e.key === "ArrowLeft") {
              // 光标在胶囊内/末尾 → 整体跳到开头；在开头不拦截（正常移出）
              if (caret > seg.start && caret <= segEnd) {
                e.preventDefault();
                ta?.setSelectionRange(seg.start, seg.start);
                return;
              }
            } else if (e.key === "ArrowRight") {
              // 光标在胶囊内/开头 → 整体跳到末尾；在末尾不拦截（正常移出）
              if (caret >= seg.start && caret < segEnd) {
                e.preventDefault();
                ta?.setSelectionRange(segEnd, segEnd);
                return;
              }
            }
          }
          onKeyDown?.(e);
        }}
        onMouseUp={() => {
          // 点击胶囊 → 原生选中胶囊全文（整体操作：退格/Del 删除、输入替换）
          const ta = textareaRef?.current;
          if (!ta) return;
          const caret = ta.selectionStart;
          if ((ta.selectionEnd ?? caret) > caret) return; // 拖选不覆盖
          const seg = segments.find(
            (s) => s.mention && caret >= s.start && caret < s.start + s.text.length
          );
          if (seg) ta.setSelectionRange(seg.start, seg.start + seg.text.length);
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
        className={`resize-none outline-none mention-input ${textareaClassName ?? ""}`}
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
