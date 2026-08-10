/** 面板消息 refs → chip 去重键（file）：模块级稳定函数，供 ChatMessageBubble memo 生效 */
const refKeyOfPanelRef = (r: { label: string }) =>
  (r as unknown as { file: string }).file;

/**
 * 右侧边栏 AI 对话面板。
 *
 * IDE 式侧边聊天，无头样式：
 * - 顶部一行：左侧面板内联错误提示（仅出错时占位）+ 右侧「新建会话 / 历史会话」图标按钮
 * - 中部消息流：Markdown 公共渲染、流式指示、自动滚底
 * - 底部输入区：textarea（Enter 发送 / Shift+Enter 换行，支持 @引用标签）
 *   + 系统提示词选择（图标 + 提示词名）+ 模型选择（图标 + 模型名）+ 发送/停止按钮
 *
 * 分层：组件只走 chatPanelStore / settingsStore / vaultStore，不直调 service。
 * 当前打开笔记经 props（noteFile）传入：新对话态自动 @ 当前笔记（可退格删除）。
 */
import {
  AlertCircle,
  ArrowDown,
  BookMarked,
  Cpu,
  FilePlus,
  Globe,
  History,
  Loader2,
  MessageSquare,
  RefreshCw,
  SendHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useAutoScrollFollow } from "@/hooks/useAutoScrollFollow";
import {
  markdownComponents,
  vaultPathNoteOf,
  wikiNoteFileOf,
} from "@/utils/markdown";
import {
  modelDisplayName,
  modelNameAcrossProviders,
  scanMentionHits,
  splitMentions,
  type MentionSeg,
} from "@/utils/text";
import { ChatMessageBubble } from "@/components/common/ChatMessageBubble";
import { MentionTextarea } from "@/components/common/MentionTextarea";
import type { EditorChatMessage, EditorChatMessageRef } from "@/types";

/** 空消息数组（模块级常量：避免 selector 新引用导致无限重渲染）。 */
const EMPTY_MESSAGES: EditorChatMessage[] = [];

/**
 * 输入框追加 @标签：前文非空且不以空格结尾时才补一个分隔空格，标签后恒带一个尾随空格。
 * 移除侧（removeAutoMention）删除标签时连尾随空格一起删——移除/追加对称，反复切换笔记不累加空格。
 */
function appendMentionTags(prev: string, tags: string[]): string {
  const sep = prev && !prev.endsWith(" ") ? " " : "";
  return prev + sep + tags.join(" ") + " ";
}

export function AiChatPanel({ noteFile, onOpenNote }: { noteFile: string | null; onOpenNote?: (file: string, title: string) => void }) {
  const sessions = useChatPanelStore((s) => s.sessions);
  const activeSessionId = useChatPanelStore((s) => s.activeSessionId);
  const streaming = useChatPanelStore((s) => s.streaming);
  const modelOverride = useChatPanelStore((s) => s.modelOverride);
  const error = useChatPanelStore((s) => s.error);
  const send = useChatPanelStore((s) => s.send);
  const stop = useChatPanelStore((s) => s.stop);
  const renameSession = useChatPanelStore((s) => s.renameSession);
  const rollbackTo = useChatPanelStore((s) => s.rollbackTo);
  const regenerate = useChatPanelStore((s) => s.regenerate);
  const newSession = useChatPanelStore((s) => s.newSession);
  const openSession = useChatPanelStore((s) => s.openSession);
  const deleteSession = useChatPanelStore((s) => s.deleteSession);
  const setSystemPromptFile = useChatPanelStore((s) => s.setSystemPromptFile);
  const setModelOverride = useChatPanelStore((s) => s.setModelOverride);
  const setToolsEnabled = useChatPanelStore((s) => s.setToolsEnabled);
  const toolsEnabled = useChatPanelStore((s) => s.toolsEnabled);
  const clearError = useChatPanelStore((s) => s.clearError);
  const vaultRoot = useAppStore((s) => s.vaultRoot);

  const active = sessions.find((s) => s.id === activeSessionId);
  const messages = active?.messages ?? EMPTY_MESSAGES;
  // 顶部标题：激活会话名（新对话态无会话 → 「新对话」）
  const activeTitle = active?.title || "新对话";
  // 系统提示词：激活会话的会话级引用；新对话态（无激活会话）读 draft（发送首条消息时固化）
  const draftSystemPromptFile = useChatPanelStore((s) => s.draftSystemPromptFile);
  const sysPromptFile = active?.systemPromptFile ?? draftSystemPromptFile;

  const [input, setInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  // 手动重新命名请求是否进行中（按钮旋转反馈 + 防重复点击）
  const [renaming, setRenaming] = useState(false);
  const handleRename = async () => {
    setRenaming(true);
    try {
      await renameSession();
    } finally {
      setRenaming(false);
    }
  };
  // assistant/user 消息的 Markdown 组件配置：useMemo 稳定化（气泡 memo 生效前提）。
  // 回调内部实时读 noteList（getState），无需响应 noteList 变化重建
  const chatMarkdownComponents = useMemo(
    () =>
      markdownComponents({
        isLocatable: () => false,
        onLocate: () => {},
        onOpenNote: (value) => {
          const hit = wikiNoteFileOf(value, useVaultStore.getState().noteList);
          if (hit) useAppStore.getState().openNote(hit.file, hit.title);
        },
        isVaultPathNote: (href) =>
          vaultPathNoteOf(href, useVaultStore.getState().noteList) != null,
        onOpenVaultPathNote: (href) => {
          const hit = vaultPathNoteOf(href, useVaultStore.getState().noteList);
          if (hit) useAppStore.getState().openNote(hit.file, hit.title);
        },
        onCreateNote: (name) => {
          void useVaultStore
            .getState()
            .createNote(name)
            .then((file) => useAppStore.getState().openNote(file, name))
            .catch((e) => console.error("创建笔记失败", e));
        },
        onOpenUrl: (url) => void useAppStore.getState().openUrl(url),
      }),
    []
  );
  // 气泡操作回调稳定化（memo 生效前提）
  const handleRollback = useCallback(
    (messageId: string) => {
      rollbackTo(messageId);
    },
    [rollbackTo]
  );
  const handleRegenerate = useCallback(() => void regenerate(), [regenerate]);
  // @chip 点击打开笔记（稳定引用，气泡 memo 生效前提）；onOpenNote 由 AiChatView 传 store action（稳定）
  const handleRefChipClick = useCallback(
    (file: string, label: string) => onOpenNote?.(file, label),
    [onOpenNote]
  );
  // 输入框内的 @引用（拖入的笔记）：@标签 随 input 文本渲染，发送时按命中实例注入笔记全文
  const [mentions, setMentions] = useState<EditorChatMessageRef[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 拖入的笔记引用队列（FileExplorerPanel 拖拽笔记到本输入框）→ 输入框追加 @标签（去重）
  const pendingMentions = useChatPanelStore((s) => s.pendingMentions);
  useEffect(() => {
    if (pendingMentions.length === 0) return;
    const added = pendingMentions.filter((r) => !mentions.some((x) => x.file === r.file));
    if (added.length) {
      setMentions((prev) => [...prev, ...added]);
      setInput((prev) => appendMentionTags(prev, added.map((r) => `@${r.label}`)));
    }
    useChatPanelStore.getState().clearPendingMentions();
  }, [pendingMentions, mentions]);

  /** 从输入框移除指定笔记的 @引用（自动 @ 跟随替换用）：按精确位置删 @标签 文本 + 移出 mentions。 */
  const removeAutoMention = (ref: EditorChatMessageRef) => {
    setMentions((prev) => prev.filter((m) => m.file !== ref.file));
    setInput((prev) => {
      const hits = scanMentionHits(prev, [{ nodeId: ref.file, text: `@${ref.label}` }]);
      if (hits.length === 0) return prev;
      const { start, end } = hits[0];
      // 连同紧邻的尾随空格一起删（追加时标签后恒带一个空格）——否则反复切换笔记会残留空格累加
      const removeEnd = end < prev.length && prev[end] === " " ? end + 1 : end;
      return prev.slice(0, start) + prev.slice(removeEnd);
    });
  };

  // 新对话态自动 @ 当前打开的笔记：输入框自动出现 @标签（可退格删除 = 该条不注入）；
  // 切笔记跟随替换（只替换自动添加的那个，手动拖入的不受影响）；
  // 发送首条消息建立会话后不再自动，「新建会话」回到新对话态重新自动；无笔记窗口激活则不自动
  const autoMentionRef = useRef<EditorChatMessageRef | null>(null);
  useEffect(() => {
    if (activeSessionId !== null) {
      autoMentionRef.current = null;
      return;
    }
    if (!noteFile) {
      if (autoMentionRef.current) {
        removeAutoMention(autoMentionRef.current);
        autoMentionRef.current = null;
      }
      return;
    }
    if (autoMentionRef.current?.file === noteFile) return;
    if (autoMentionRef.current) removeAutoMention(autoMentionRef.current);
    const ref: EditorChatMessageRef = {
      file: noteFile,
      label: noteFile.split("/").pop()?.replace(/\.md$/i, "") ?? noteFile,
    };
    autoMentionRef.current = ref;
    setMentions((prev) => [...prev, ref]);
    setInput((prev) => appendMentionTags(prev, [`@${ref.label}`]));
  }, [noteFile, activeSessionId]);

  // 仓库切换时强制重载会话（双保险）：selectVault 已 load 一次，但若其中间某步异常被
  // catch 跳过（如 global.json 写入失败），此处保证消息区/历史列表一定跟随新仓库刷新
  useEffect(() => {
    if (!vaultRoot) return;
    setShowHistory(false);
    setShowModelPicker(false);
    setShowPromptPicker(false);
    void useChatPanelStore.getState().load(useAppStore.getState().vaultId);
  }, [vaultRoot]);

  // 智能滚动跟随：贴底自动跟随新消息；上翻停止跟随 + 「新消息」回底按钮（与画布对话节点共用 hook）
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastContent = messages.length ? messages[messages.length - 1].content : "";
  const { handleScroll, jumpToBottom, showJumpToBottom } = useAutoScrollFollow(scrollRef, [
    messages.length,
    lastContent,
  ]);

  const providers = useSettingsStore((s) => s.config.providers);
  // 跟随默认时显示真实生效模型名（resolveDefaultModel：仓库默认模型反查所属供应商，均为落盘配置；昵称优先展示）
  const defaultModelName = useSettingsStore((s) => s.resolveDefaultModel()?.model ?? null);
  const defaultModelDisplay = defaultModelName ? modelNameAcrossProviders(providers, defaultModelName) : null;
  // 覆盖模型按所属供应商取昵称；供应商已删时回退原模型 ID（防错显示同名模型的别家昵称）
  const overrideProvider = modelOverride?.providerId
    ? providers.find((p) => p.id === modelOverride.providerId)
    : undefined;
  const overrideDisplay =
    modelOverride?.model && overrideProvider
      ? modelDisplayName(overrideProvider, modelOverride.model)
      : (modelOverride?.model ?? null);
  const noteList = useVaultStore((s) => s.noteList);
  // 系统提示词候选：实际存在的笔记 ∩ 已标记列表（文件面板右键 .md 注册/注销，独立落盘 .atelyx/prompt-notes.json）
  const promptFiles = useSettingsStore((s) => s.promptNotes);
  const promptNotes = noteList.filter((n) => promptFiles.includes(n.file));

  // 输入框 overlay 分段：@引用 → 圆角标签段（可删除），其余普通文本段
  const segments = splitMentions(
    input,
    mentions.map((r) => ({ nodeId: r.file, text: `@${r.label}` }))
  );

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setMentions([]);
    // 立即终止自动 @ 标记：若先清 input 再等 send 设置 activeSessionId，中间一帧
    // effect 会因「笔记已切换」把新笔记的 @标签 重新塞回已清空的输入框（发送后残留）
    autoMentionRef.current = null;
    void send(text, mentions);
  };

  // 删除输入框内 @引用 标签：按命中实例精确位置移除（重复引用时不错位），同时移出 mentions
  const removeMention = (seg: MentionSeg) => {
    const start = seg.start;
    setInput((prev) => prev.slice(0, start) + prev.slice(start + seg.text.length));
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start, start);
      }
    });
    if (seg.mention) {
      setMentions((prev) => prev.filter((m) => m.file !== seg.mention?.nodeId));
    }
  };

  return (
    <div
      className="h-full flex flex-col overflow-hidden relative"
      style={{ background: "var(--bg-secondary)", color: "var(--text-primary)" }}
    >
      {/* 顶部无头行：左侧会话标题（出错时显示错误提示）+ 右侧会话管理按钮 */}
      <div
        className="px-2 py-1.5 border-b flex items-center gap-2 flex-shrink-0 min-h-9"
        style={{ borderColor: "var(--border)" }}
        data-tauri-drag-region
      >
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <MessageSquare
            size={13}
            className="flex-shrink-0"
            style={{ color: "var(--text-muted)" }}
          />
          {error ? (
            <span
              className="flex items-center gap-1 min-w-0 text-xs"
              style={{ color: "#f87171" }}
            >
              <AlertCircle size={13} className="flex-shrink-0" />
              <span className="truncate">{error}</span>
              <button
                onClick={clearError}
                title="清除"
                className="p-0.5 hover:opacity-70 flex-shrink-0"
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <>
              <span
                className="truncate text-xs font-medium"
                style={{ color: "var(--text-primary)" }}
                title={activeTitle}
              >
                {activeTitle}
              </span>
              {/* 手动重新命名：按全部会话记录请求 LLM 生成标题（新对话态/流式中禁用）；请求中旋转 + 防重复点击 */}
              {active && !streaming && (
                <button
                  onClick={() => void handleRename()}
                  disabled={renaming}
                  title={renaming ? "正在生成标题…" : "重新命名（按全部会话记录生成标题）"}
                  aria-label="重新命名"
                  className="p-0.5 rounded hover:opacity-80 flex-shrink-0 disabled:opacity-60 disabled:cursor-default disabled:hover:opacity-60"
                  style={{ color: "var(--text-muted)" }}
                >
                  {renaming ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0" data-tauri-drag-region="false">
          <button
            onClick={newSession}
            title="新建会话"
            aria-label="新建会话"
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: "var(--text-secondary)" }}
          >
            <FilePlus size={15} />
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            title="历史会话"
            aria-label="历史会话"
            className="p-1.5 rounded hover:opacity-80"
            style={{ color: showHistory ? "var(--accent)" : "var(--text-secondary)" }}
          >
            <History size={15} />
          </button>
        </div>
      </div>

      {/* 历史会话浮层（当前面板全部会话，按最近使用倒序；点击切换、可删除） */}
      {showHistory && (
        <div className="fixed inset-0 z-40" onClick={() => setShowHistory(false)} />
      )}
      {showHistory && (
        <div
          className="absolute right-2 top-9 z-50 w-64 border rounded shadow-lg py-1 max-h-72 overflow-auto"
          style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
        >
          <div className="px-3 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            历史会话
          </div>
          {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1 px-2 py-1.5 text-xs"
              style={{
                background: s.id === activeSessionId ? "var(--bg-tertiary)" : undefined,
                color: "var(--text-primary)",
              }}
            >
              <button
                onClick={() => {
                  openSession(s.id);
                  setShowHistory(false);
                }}
                className="flex-1 text-left truncate min-w-0 hover:opacity-80"
                title={s.title ?? "未命名对话"}
              >
                {s.title ?? "未命名对话"}
              </button>
              <button
                onClick={() => deleteSession(s.id)}
                title="删除会话"
                aria-label={`删除会话 ${s.title ?? ""}`}
                className="p-0.5 hover:opacity-70 flex-shrink-0"
                style={{ color: "var(--text-muted)" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              暂无历史会话
            </div>
          )}
        </div>
      )}

      {/* 消息流（relative 容器承载回底按钮，结构与画布对话节点一致） */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-auto px-3 py-3 space-y-3 min-h-0"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-xs select-none" style={{ color: "var(--text-muted)" }}>
              <MessageSquare size={24} strokeWidth={1.5} className="opacity-60" />
              开始新的 AI 对话
              {noteFile && (
                <span className="text-[11px]">已自动引用当前笔记（退格可删除）</span>
              )}
            </div>
          ) : (
            messages.map((m, i) => {
              // 流式指示：最后一条 assistant 占位且正在流式
              const isStreamingMsg = streaming && m.role === "assistant" && i === messages.length - 1;
              // 重新生成：仅最后一条完整 AI 回复可用（同画布 canRegenerate）
              const canRegenerate =
                !streaming &&
                m.role === "assistant" &&
                i === messages.length - 1 &&
                m.content.trim() !== "" &&
                !m.content.startsWith("[错误]");
              return (
                <ChatMessageBubble
                  key={m.id}
                  role={m.role}
                  displayContent={m.role === "user" ? m.displayContent ?? m.content : undefined}
                  refs={m.refs}
                  refKeyOf={refKeyOfPanelRef}
                  onRefChipClick={handleRefChipClick}
                  renderUserMarkdown
                  content={m.content}
                  reasoningContent={m.reasoningContent}
                  isStreaming={isStreamingMsg}
                  markdownComponents={chatMarkdownComponents}
                  streamingPlaceholder={
                    <span
                      className="inline-flex items-center gap-1 text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Loader2 size={12} className="animate-spin" /> 生成中…
                    </span>
                  }
                  copyText={m.role === "user" ? (m.displayContent ?? m.content) : m.content}
                  messageId={m.id}
                  canRollback={!isStreamingMsg && m.role === "assistant" && m.content.trim() !== ""}
                  onRollback={handleRollback}
                  onRegenerate={canRegenerate ? handleRegenerate : undefined}
                  userBubbleClass="bg-[var(--bg-tertiary)]"
                  assistantBubbleStyle={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}
                  paddingClass="px-3 py-2 text-sm leading-relaxed min-w-0"
                />
              );
            })
          )}
        </div>
        {showJumpToBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 text-xs rounded-full px-2.5 py-1 shadow-lg hover:opacity-80"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          >
            <ArrowDown size={12} /> 新消息
          </button>
        )}
      </div>

      {/* 底部输入区：textarea + 内部底部工具条（左：提示词/模型；右：发送） */}
      <div className="border-t flex-shrink-0" style={{ borderColor: "var(--border)" }}>
        {/* textarea + 内部工具条（absolute 叠放，textarea 有 pb 留白） */}
        <div className="relative">
          {/* 输入框内底部工具条：左 提示词/模型；右 发送/停止 */}
          <div className="absolute inset-x-0 bottom-3 z-10 px-1.5 flex items-center gap-0.5">
          {/* 系统提示词选择：图标 + 当前提示词名（超宽消隐） */}
          <div className="relative">
            <button
              onClick={() => setShowPromptPicker((v) => !v)}
              title={sysPromptFile ? `系统提示词：${sysPromptFile.split("/").pop()?.replace(/\.md$/i, "")}` : "选择系统提示词（右键笔记注册）"}
              className="px-1.5 py-1 rounded text-xs flex items-center gap-1 hover:opacity-80 w-28 min-w-0"
              style={{ color: "var(--text-secondary)" }}
            >
              <BookMarked size={13} className="flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate">{sysPromptFile ? sysPromptFile.split("/").pop()?.replace(/\.md$/i, "") : "提示词"}</span>
            </button>
            {showPromptPicker && <div className="fixed inset-0 z-40" onClick={() => setShowPromptPicker(false)} />}
            {showPromptPicker && (
              <div
                className="absolute bottom-full mb-1 left-0 z-50 w-56 border rounded shadow-lg py-1 max-h-60 overflow-auto"
                style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              >
                <button
                  onClick={() => { setSystemPromptFile(undefined); setShowPromptPicker(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]"
                  style={{ color: sysPromptFile ? "var(--text-primary)" : "var(--accent)" }}
                >
                  不使用
                </button>
                {promptNotes.map((n) => {
                  const file = n.file;
                  const selected = file === sysPromptFile;
                  return (
                    <button
                      key={n.name}
                      onClick={() => { setSystemPromptFile(selected ? undefined : file); setShowPromptPicker(false); }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] truncate"
                      style={{ color: selected ? "var(--accent)" : "var(--text-primary)" }}
                    >
                      {n.name.replace(/\.md$/i, "")}
                    </button>
                  );
                })}
                {promptNotes.length === 0 && (
                  <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    暂无提示词笔记（在文件面板右键笔记 → 注册为提示词）
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 模型选择：图标 + 当前模型名（超宽消隐；未覆盖 = 跟随仓库默认） */}
          <div className="relative">
            <button
              onClick={() => setShowModelPicker((v) => !v)}
              title={modelOverride ? `模型：${modelOverride.model}` : "模型：跟随仓库默认（点击选择）"}
              className="px-1.5 py-1 rounded text-xs flex items-center gap-1 hover:opacity-80 w-28 min-w-0"
              style={{ color: "var(--text-secondary)" }}
            >
              <Cpu size={13} className="flex-shrink-0" />
              <span className="flex-1 min-w-0 truncate">
                {overrideDisplay ?? (defaultModelDisplay ?? "默认")}
              </span>
            </button>
            {showModelPicker && <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />}
            {showModelPicker && (
              <div
                className="absolute bottom-full mb-1 left-0 z-50 w-56 border rounded shadow-lg py-1 max-h-60 overflow-auto"
                style={{ background: "var(--bg-secondary)", borderColor: "var(--border)" }}
              >
                <button
                  onClick={() => { setModelOverride(null); setShowModelPicker(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)]"
                  style={{ color: modelOverride ? "var(--text-primary)" : "var(--accent)" }}
                >
                  跟随仓库默认
                </button>
                {providers.map((p) =>
                  p.models.length ? (
                    <div key={p.id}>
                      {/* 组头 = 供应商名（---供应商--- 样式） */}
                      <div
                        className="px-3 pt-1.5 pb-0.5 text-[10px] truncate"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {p.name}
                      </div>
                      {p.models.map((m) => (
                        <button
                          key={`${p.id}::${m.id}`}
                          onClick={() => { setModelOverride({ providerId: p.id, model: m.id }); setShowModelPicker(false); }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] truncate"
                          style={{ color: modelOverride?.providerId === p.id && modelOverride?.model === m.id ? "var(--accent)" : "var(--text-primary)" }}
                        >
                          {modelDisplayName(p, m.id)}
                        </button>
                      ))}
                    </div>
                  ) : null
                )}
                {providers.every((p) => p.models.length === 0) && (
                  <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    暂无已配置模型（请在设置中添加供应商）
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 联网搜索工具开关：开启后 AI 自主决定联网搜索（需搜索源已配置，未配置发送时提示） */}
          <div className="relative">
            <button
              onClick={() => setToolsEnabled(!toolsEnabled)}
              title={
                toolsEnabled
                  ? "联网搜索：已开启（AI 可自主联网搜索）"
                  : "联网搜索：关闭（点击开启）"
              }
              aria-label="联网搜索工具"
              className="px-1.5 py-1 rounded text-xs flex items-center gap-1 hover:opacity-80"
              style={{ color: toolsEnabled ? "var(--accent)" : "var(--text-secondary)" }}
            >
              <Globe size={13} className="flex-shrink-0" />
            </button>
          </div>
          <div className="flex-1" />
          {/* 右：发送 / 停止（图标 only，金色圆钮，流式中切换为停止）——mr-1 右缘留白不顶格 */}
          <button
            onClick={streaming ? stop : handleSend}
            disabled={!streaming && !input.trim()}
            title={streaming ? "停止" : "发送 (Enter)"}
            aria-label={streaming ? "停止" : "发送"}
            className="p-1.5 rounded flex-shrink-0 mr-1 disabled:opacity-40"
            style={{
              background: streaming ? "var(--bg-tertiary)" : "var(--accent)",
              color: streaming ? "var(--text-secondary)" : "var(--accent-fg)",
            }}
          >
            {streaming ? <Square size={13} /> : <SendHorizontal size={13} />}
          </button>
        </div>

        {/* 输入框（data-chat-input = 文件面板拖拽笔记的落点：拖入即 @引用）：
        overlay 渲染 @标签（透明 textarea 承载输入，滚动同步 transform） */}
        <div className="relative" data-chat-input>
          <MentionTextarea
            textareaRef={textareaRef}
            value={input}
            onChange={(v) => setInput(v)}
            segments={segments}
            onRemoveMention={removeMention}
            onKeyDown={(e) => {
              // Enter 发送 / Shift+Enter 换行；IME 组合期间 Enter 是「上屏候选词」而非发送
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            spellCheck={false}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行（新会话自动 @ 当前笔记，拖入笔记 = @引用）"
            rows={5}
            overlayClassName="z-0 px-2 pt-3 pb-12 text-sm leading-relaxed"
            textareaClassName="w-full px-2 pt-3 pb-12 text-sm leading-relaxed"
          />
        </div>
        </div>
      </div>
    </div>
  );
}

