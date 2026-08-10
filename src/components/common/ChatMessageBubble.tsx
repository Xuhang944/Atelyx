/**
 * 聊天消息气泡（画布对话节点 / AI 对话面板共用）。
 *
 * 收敛两处的重复实现：气泡容器 + @引用 chip（去重/剔除）+ 附件缩略 + 思考折叠 +
 * Markdown 渲染 + 操作按钮组（复制/回到此处/分支/重新生成）。
 * 差异由 props 表达：配色变体、@chip 点击行为（画布 = 定位节点，面板 = 打开笔记）、
 * 附件（仅画布有）、user 正文是否走 Markdown（面板有）。
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
import { scanMentionHits } from "@/utils/text";
import type { Attachment } from "@/types";

/** @引用 chip 数据源（调用方把消息 refs 归一化为 {key, label}：画布 key = nodeId，面板 key = file）。 */
export interface BubbleMentionRef {
  key: string;
  label: string;
}

interface ChatMessageBubbleProps {
  /** 消息归属：user = 右对齐 + 用户底色；assistant = 左对齐。 */
  role: "user" | "assistant";
  /** user 气泡显示文本（原始输入含 @标签，组件内剔除后渲染）。 */
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
  /** user 正文是否走 Markdown 渲染（面板 = true；画布 = 纯文本）。 */
  renderUserMarkdown?: boolean;
  /** assistant 气泡 Markdown 原文（空时显示占位/思考块）。 */
  content?: string;
  /** 模型思考过程（折叠展示）。 */
  reasoningContent?: string;
  /** 是否进行中的流式消息（思考块折叠态显示等待动画）。 */
  isStreaming: boolean;
  /** 流式且无内容时的占位（画布缺省 = "..."，面板 = Loader2 生成中…）。 */
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
  /** user 气泡底色（画布 = accent 金底；面板 = bg-tertiary）。 */
  userBubbleClass?: string;
  /** assistant 气泡额外样式（面板 = 边框；画布无）。 */
  assistantBubbleStyle?: CSSProperties;
  /** 气泡内边距类（画布紧凑 / 面板宽松）。 */
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
  renderUserMarkdown,
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
  // user 气泡显示文本：原始输入剔除 @引用标签（引用内容已随消息注入历史，气泡不重复展示 @标题）
  const cleanText = useMemo(() => {
    if (!displayContent) return "";
    const hits = scanMentionHits(
      displayContent,
      (mentionRefs ?? []).map((r) => ({ nodeId: r.key, text: `@${r.label}` }))
    );
    let out = "";
    let last = 0;
    for (const h of hits) {
      if (h.start > last) out += displayContent.slice(last, h.start);
      last = h.end;
    }
    if (last < displayContent.length) out += displayContent.slice(last);
    return out;
  }, [displayContent, mentionRefs]);
  // @chip 按源去重（同一节点/笔记被重复引用时气泡只显示一个 @标题，不累计）
  const uniqueRefs = useMemo(() => {
    if (!mentionRefs) return undefined;
    const seen = new Set<string>();
    return mentionRefs.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  }, [mentionRefs]);
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
        {isUser && (uniqueRefs?.length ?? 0) > 0 && (
          /* @chip 组：显示 @引用标题，点击行为由调用方绑定（画布 = 定位节点，面板 = 打开笔记） */
          <div className="flex flex-wrap gap-1 mb-1">
            {uniqueRefs!.map((ref) => (
              <button
                key={ref.key}
                onClick={() => onRefChipClick?.(ref.key, ref.label)}
                title={`定位到 ${ref.label}`}
                className="inline-flex items-center text-xs rounded px-1.5 py-0.5 border max-w-40 hover:opacity-80"
                style={{ background: "rgba(255,255,255,.15)", borderColor: "rgba(255,255,255,.3)", color: "#fff" }}
              >
                <span className="truncate">@{ref.label}</span>
              </button>
            ))}
          </div>
        )}
        {isUser ? (
          renderUserMarkdown ? (
            <div className="markdown-body max-w-none break-words">
              <ReactMarkdown
                remarkPlugins={MARKDOWN_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {cleanText}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">{cleanText}</div>
          )
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
