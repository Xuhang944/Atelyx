/**
 * 聊天消息气泡（画布对话节点 / AI 对话面板共用）。
 *
 * 收敛两处的重复实现：气泡容器 + @引用胶囊（按原文位置内嵌）+ 附件缩略 + 思考折叠 +
 * Markdown 渲染 + 操作按钮组（复制/回到此处/分支/重新生成）。
 * user/assistant 消息统一 Markdown 渲染；差异由 props 表达：配色变体、@胶囊 点击行为
 * （画布 = 定位节点，面板 = 打开笔记）、附件（仅画布有）、分支/重新生成（入口各自）。
 *
 * memo 生效前提：markdownComponents 必须 useMemo 稳定化、onRollback/onBranch 等
 * 回调 useCallback——流式期间历史消息靠引用不变跳过重渲染（assistant 消息无 refs/
 * 附件，引用天然稳定，重渲染最贵的 ReactMarkdown 得以跳过）。
 */
import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy, FileText, GitBranch, History, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { ThinkingBlock } from "@/components/common/ThinkingBlock";
import { MARKDOWN_PLUGINS, REHYPE_PLUGINS } from "@/utils/markdown";
import { splitMentions } from "@/utils/text";
import type { Attachment } from "@/types";

interface ChatMessageBubbleProps {
  /** 消息归属：user = 右对齐 + 用户底色；assistant = 左对齐。 */
  role: "user" | "assistant";
  /** user 气泡显示文本（原始输入含 @标签，组件内按原文位置渲染胶囊）。 */
  displayContent?: string;
  /**
   * 消息原始 refs（直接传消息对象自带数组，**不要 map 出新数组**——
   * 否则父组件每次渲染新引用，memo 对所有气泡失效，流式期间历史消息的 Markdown 被反复重解析）。
   * key 由 refKeyOf 提取；label 两处消息类型同构，直接读。
   */
  refs?: { label: string }[];
  /** 从 ref 提取 chip 去重键（画布 = nodeId，面板 = file）；模块级稳定函数。 */
  refKeyOf?: (ref: { label: string }) => string;
  /** @chip 点击（画布 = 定位节点；面板 = 打开笔记）。 */
  onRefChipClick?: (refKey: string, label: string) => void;
  /** assistant 气泡 Markdown 原文（空时显示占位/思考块）。 */
  content?: string;
  /** 模型思考过程（折叠展示）。 */
  reasoningContent?: string;
  /** 是否进行中的流式消息（思考块折叠态显示等待动画）。 */
  isStreaming: boolean;
  /** 流式且无内容时的占位（调用方不传时 = "..."）。 */
  streamingPlaceholder?: ReactNode;
  /** 历史消息附件缩略（仅画布消息有；面板消息无附件）。 */
  attachments?: Attachment[];
  /** 附件图片右键 → 拉出为媒体节点（仅画布传）。 */
  onMediaExtract?: (att: Attachment) => void;
  /** assistant Markdown 的组件工厂结果（调用方 useMemo 稳定化；缺省 = 纯渲染无链接拦截）。 */
  markdownComponents?: Components;
  /** 复制内容（气泡所见原文，调用方算好：user = displayContent ?? content，assistant = content）。 */
  copyText: string;
  messageId: string;
  /** 仅完整 AI 回复可「回到此处」。 */
  canRollback: boolean;
  onRollback?: (messageId: string) => void;
  /** 分支（仅画布对话节点有）。 */
  onBranch?: (messageId: string) => void;
  /** 重新生成（仅 AI 对话面板有）。 */
  onRegenerate?: () => void;
  /** user 气泡底色类（画布与面板均 = bg-tertiary 灰底）。 */
  userBubbleClass?: string;
  /** assistant 气泡额外样式（两入口同款 = bg-primary + 边框）。 */
  assistantBubbleStyle?: CSSProperties;
  /** 气泡内边距类（两入口同款宽松）。 */
  paddingClass?: string;
  /** React Flow 内使用时阻止事件冒泡（画布传 true，防拖动/连线误触）。 */
  stopPropagation?: boolean;
}

export const ChatMessageBubble = memo(function ChatMessageBubble({
  role,
  displayContent,
  refs,
  refKeyOf,
  onRefChipClick,
  content,
  reasoningContent,
  isStreaming,
  streamingPlaceholder,
  attachments,
  onMediaExtract,
  markdownComponents,
  copyText,
  messageId,
  canRollback,
  onRollback,
  onBranch,
  onRegenerate,
  userBubbleClass,
  assistantBubbleStyle,
  paddingClass = "px-2.5 py-1.5",
  stopPropagation,
}: ChatMessageBubbleProps) {
  const isUser = role === "user";
  // 复制反馈 1.5s 后复原（复制内容 = 气泡所见原文）
  const [copied, setCopied] = useState(false);
  const copyMessage = () => {
    void navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const atts = attachments ?? [];
  // refs → {key, label} 归一化：refs 为消息对象自带数组（引用稳定），refKeyOf 为模块级稳定函数，
  // 该 useMemo 只在消息自身 refs 变化时重算——历史消息 memo 跳过渲染
  const mentionRefs = useMemo(() => {
    if (!refs || !refKeyOf) return undefined;
    return refs.map((r) => ({ key: refKeyOf(r), label: r.label }));
  }, [refs, refKeyOf]);
  // user 气泡按原文位置切分（@引用 → 胶囊段，其余普通文本段）——胶囊与输入框同位置就地渲染，
  // 不另起独立 chip 行；无引用时 = 单普通段整段渲染，行为与未切分一致
  const userSegs = useMemo(() => {
    if (!displayContent) return undefined;
    return splitMentions(
      displayContent,
      (mentionRefs ?? []).map((r) => ({ nodeId: r.key, text: `@${r.label}` }))
    );
  }, [displayContent, mentionRefs]);
  // 分段渲染的 Markdown 组件：段落内联化（p → span）——纯文本碎片段与 @胶囊 同一文本流不独占行，
  // 段内块级语法（列表/代码块等）照常块级；依赖 markdownComponents（调用方 useMemo 稳定）→ 引用稳定（气泡 memo 前提）
  const segComponents = useMemo(() => ({ ...markdownComponents, p: InlineP }), [markdownComponents]);
  const stopProps = stopPropagation
    ? {
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      }
    : {};

  return (
    <div className={`group relative flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`relative max-w-[85%] rounded-lg ${paddingClass} ${isUser ? (userBubbleClass ?? "") : ""}`}
        style={{
          cursor: "text",
          userSelect: "text",
          WebkitUserSelect: "text",
          ...(isUser
            ? {}
            : {
                background: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                ...assistantBubbleStyle,
              }),
        }}
      >
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {atts.map((att, i) =>
              att.kind === "image" && att.payload ? (
                <img
                  key={i}
                  src={att.payload}
                  alt={att.filename ?? ""}
                  className="max-h-32 rounded border"
                  style={{ borderColor: "var(--border)", background: "var(--bg-card)" }}
                  draggable={false}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMediaExtract?.(att);
                  }}
                  title="右键：拉出为媒体节点"
                />
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5"
                  style={{ background: "rgba(128,128,128,.2)" }}
                  title={att.filename}
                >
                  <FileText size={12} className="flex-shrink-0" /> {att.filename || "文件"}
                </span>
              )
            )}
          </div>
        )}
        {isUser ? (
          <div className="markdown-body max-w-none break-words">
            {userSegs?.map((seg, i) =>
              seg.mention ? (
                <RefChip
                  key={i}
                  text={seg.text}
                  nodeId={seg.mention.nodeId}
                  label={seg.mention.text.slice(1)}
                  onRefChipClick={onRefChipClick}
                />
              ) : (
                <ReactMarkdown
                  key={i}
                  remarkPlugins={MARKDOWN_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={segComponents}
                >
                  {seg.text}
                </ReactMarkdown>
              )
            )}
          </div>
        ) : (
          <div className="markdown-body max-w-none break-words">
            {reasoningContent ? (
              <ThinkingBlock text={reasoningContent} streaming={isStreaming} />
            ) : null}
            {isStreaming && !content && !reasoningContent && streamingPlaceholder != null ? (
              streamingPlaceholder
            ) : (
              <ReactMarkdown
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {content || (reasoningContent ? "" : "...")}
              </ReactMarkdown>
            )}
          </div>
        )}
      </div>
      {/* 气泡下方操作按钮组：复制（全部消息）+ 回到此处（完整 AI 回复），hover 浮现 */}
      <div
        className={`nodrag absolute top-full mt-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100 z-10 ${isUser ? "right-0" : "left-0"}`}
        {...stopProps}
      >
        <button
          onClick={copyMessage}
          title="复制消息"
          aria-label="复制消息"
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px]"
          style={{ color: "var(--text-muted)" }}
        >
          {copied ? <Check size={12} className="flex-shrink-0" /> : <Copy size={12} className="flex-shrink-0" />}
          {copied ? "已复制" : "复制"}
        </button>
        {canRollback && (
          <button
            onClick={() => onRollback?.(messageId)}
            title="截断此消息之后的全部消息，在此处继续对话（可撤销）"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            <History size={12} className="flex-shrink-0" />
            回到此处
          </button>
        )}
        {onBranch && (
          <button
            onClick={() => onBranch(messageId)}
            title="在此处创建分支对话节点"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            <GitBranch size={12} className="flex-shrink-0" />
            分支
          </button>
        )}
        {onRegenerate && (
          <button
            onClick={onRegenerate}
            title="重新生成最后一条回复"
            aria-label="重新生成"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            <RefreshCw size={12} className="flex-shrink-0" /> 重新生成
          </button>
        )}
      </div>
    </div>
  );
});

/** 段落内联化（p → span）：分段渲染的普通文本碎片段与 @胶囊 同一文本流（块级 p 会独占行把句子拆开）。 */
const InlineP = ({ children }: { children?: ReactNode }) => <span>{children}</span>;

/** user 气泡内嵌 @引用 胶囊（与输入框标签同位置渲染，点击行为由调用方绑定：画布 = 定位节点，面板 = 打开笔记）。 */
function RefChip({
  text,
  nodeId,
  label,
  onRefChipClick,
}: {
  text: string;
  nodeId: string;
  label: string;
  onRefChipClick?: (refKey: string, label: string) => void;
}) {
  return (
    <button
      onClick={() => onRefChipClick?.(nodeId, label)}
      title={`定位到 ${label}`}
      className="inline-flex items-center rounded-full px-2 py-0.5 border align-baseline transition-all hover:brightness-110"
      style={{
        background: "color-mix(in srgb, var(--accent) 18%, transparent)",
        borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
        color: "var(--accent)",
      }}
    >
      {text}
    </button>
  );
}
