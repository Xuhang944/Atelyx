import { Globe, Loader2, Plus, RefreshCw, Scissors, X } from "lucide-react";
import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { NodeResizeControl, useReactFlow, type NodeProps } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useAutoScrollFollow } from "@/hooks/useAutoScrollFollow";
import { DEFAULT_CONVERSATION_WIDTH, DEFAULT_CONVERSATION_HEIGHT, DEFAULT_TEXT_NODE_WIDTH, DEFAULT_TEXT_NODE_HEIGHT } from "@/constants/canvas";
import { isAssetConsumed } from "@/utils/consumed";
import { findFreeSpot } from "@/utils/layout";
import {
  mentionTextOf,
  modelDisplayName,
  modelNameAcrossProviders,
  prefix,
  splitMentions,
  type MentionSeg,
} from "@/utils/text";
import {
  markdownComponents,
} from "@/utils/markdown";
import type {
  ConversationData,
  MediaData,
  PendingAttachment,
  Attachment,
} from "@/types";
import type { Node as FlowNode } from "@xyflow/react";
import { ConversationAtPicker } from "./ConversationAtPicker";
import { ConversationAttachmentTray } from "./ConversationAttachmentTray";
import { ConnectionFrame } from "./ConnectionFrame";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import { ChatMessageBubble } from "@/components/common/ChatMessageBubble";
import { MentionTextarea } from "@/components/common/MentionTextarea";
import { JumpToBottomButton } from "@/components/common/JumpToBottomButton";
import { useInlineEdit } from "@/hooks/useInlineEdit";
import { useVaultLinkHandlers } from "@/hooks/useVaultLinkHandlers";
import { useWikiNodeLocate } from "@/hooks/useWikiNodeLocate";

/** 模块级空数组，避免 selector 每次返回新引用导致 React 无限循环。 */
const EMPTY_MESSAGES: never[] = [];
const FALSE = false as const;
/** 拖线引用队列的空数组占位（selector 稳定引用）。 */
const EMPTY_PENDING: string[] = [];

/** 待发送附件 → 媒体节点 data（影子节点 / 固定到画布共用，） */
function toMediaData(att: PendingAttachment): MediaData & Record<string, unknown> {
  return {
    mime: att.mime,
    kind: att.kind,
    name: att.filename,
    thumb: att.kind === "image" ? att.payload : undefined,
    body: att.kind === "file" ? att.payload : undefined,
    parseFailed: att.parseFailed,
  };
}

/** 画布消息 refs → chip 去重键（nodeId）：模块级稳定函数，供 ChatMessageBubble memo 生效 */
const refKeyOfNodeRef = (r: { label: string }) =>
  (r as unknown as { nodeId: string }).nodeId;

/**
 * 对话节点。
 * 消息列表 + 输入框 + 流式渲染 + Markdown。
 * - 输入框支持粘贴/拖拽附件 → 待发送托盘
 * - @ 提及引用画布资产：@chips 常驻显示入边引用
 * - 连接边框（2.4/7.2）：四周虚线边框拉线接入引用 / 拖线引用（发送时自动连线）
 */
export function ConversationNode({ id, width, height }: NodeProps) {
  const hasFixedHeight = height != null;
  const messages = useCanvasStore((s) => s.messagesByConv[id] ?? EMPTY_MESSAGES);
  const streaming = useCanvasStore((s) => s.streamingByConv[id] ?? FALSE);
  const send = useCanvasStore((s) => s.send);
  const regenerate = useCanvasStore((s) => s.regenerate);
  const rollbackTo = useCanvasStore((s) => s.rollbackTo);
  const abort = useCanvasStore((s) => s.abort);
  const branchFrom = useCanvasStore((s) => s.branchFrom);
  const error = useCanvasStore((s) => s.error);
  const clearError = useCanvasStore((s) => s.clearError);
  const addNode = useCanvasStore((s) => s.addNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const { fitView } = useReactFlow();
  const providers = useSettingsStore((s) => s.config.providers);
  // 未指定（跟随仓库默认）时下拉显示真实生效模型名（resolveDefaultModel：仓库默认模型反查所属供应商，均为落盘配置；昵称优先展示）
  const defaultModelName = useSettingsStore((s) => s.resolveDefaultModel()?.model ?? null);
  const defaultModelDisplay =
    defaultModelName ? modelNameAcrossProviders(providers, defaultModelName) : null;
  const nodeData = useCanvasStore(
    (s) => s.nodes.find((n) => n.id === id)?.data
  ) as Partial<ConversationData> | undefined;

  // 供应商·模型组合选项（供节点一步选择；留空 = 跟随仓库默认）
  const comboOptions = providers.flatMap((p) =>
    p.models.map((m) => ({
      key: `${p.id}::${m.id}`,
      label: modelDisplayName(p, m.id),
      group: p.name,
      providerId: p.id,
      model: m.id,
    })),
  );
  const currentComboKey =
    nodeData?.providerId && nodeData?.model ? `${nodeData.providerId}::${nodeData.model}` : "";

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 标题：LLM 自动命名 → 回退首条 user 消息前缀 → 「对话」；双击 inline 编辑（空提交 = 清除回退显示）
  const firstUserMsg = messages.find((m) => m.role === "user");
  const displayTitle =
    nodeData?.title || prefix(firstUserMsg?.displayContent ?? firstUserMsg?.content ?? "", 12) || "对话";
  const titleEdit = useInlineEdit({
    value: displayTitle,
    onCommit: (v) => {
      const t = v.trim();
      if (t === displayTitle) return;
      updateNodeData(id, { title: t || undefined });
    },
  });
  const [picker, setPicker] = useState<{ x: number; y: number; openUp: boolean; yBottom: number; query: string } | null>(null);
  // 记录 @ 触发时光标位置（@ 尚未插入，插入后 @ 即在该索引），用于精确删除而非只删末尾
  const [atIdx, setAtIdx] = useState(-1);
  // @ 提及映射：输入框内可见的 @显示名 → 源节点 id，发送时按文本就地替换为引用内容
  const [mentions, setMentions] = useState<{ nodeId: string; text: string }[]>([]);
  // 仅订阅「本节点入边的 media 源节点」派生数据（useShallow 保证引用稳定）：
  // 拖拽其他节点（nodes 数组变化但未变节点对象引用保留）时不触发本组件重渲染/重跑 effect
  const mediaSources = useCanvasStore(
    useShallow((s) =>
      s.edges
        .filter(
          (e) =>
            e.target === id &&
            (e.data as { inject?: boolean } | undefined)?.inject !== false
        )
        .map((e) => s.nodes.find((n) => n.id === e.source))
        .filter((n): n is FlowNode => !!n && n.type === "media")
    )
  );

  // ===== 系统提示词：从已标记笔记选择（文件面板右键 .md → 注册为提示词），发送时注入 system 消息 =====
  const noteList = useVaultStore((s) => s.noteList);
  // 候选 = 实际存在的笔记 ∩ 已标记列表（右键注册/注销，独立落盘 .atelyx/prompt-notes.json）
  const promptFiles = useSettingsStore((s) => s.promptNotes);
  const promptNotes = noteList.filter((n) => promptFiles.includes(n.file));
  const sysPromptFile = nodeData?.systemPromptFile;
  // 文件面板未加载过时补拉一次笔记列表（正常路径 ProjectWorkspacePage 已加载）
  useEffect(() => {
    if (noteList.length === 0) void useVaultStore.getState().loadFiles();
  }, [noteList.length]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ===== 智能滚动跟随：贴底时自动跟随新消息；用户上翻看历史时不被拉走，显示「新消息」回底按钮（与 AI 对话面板共用 hook） =====
  const { handleScroll, jumpToBottom, showJumpToBottom } = useAutoScrollFollow(scrollRef, [messages]);

  // 阻止滚轮事件冒泡到 React Flow（防止画布缩放）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // 画布媒体节点新连入 → 自动进待发送托盘（画布媒体节点通道。
  // 已通过该对话发送过的附件（含发送时自动归档的影子节点）不再重复进托盘：
  // 以消息历史中的附件 payload 判定（图片进历史后被重发，无需重复注入）。
  useEffect(() => {
    setAttachments((prev) => {
      const sentPayloads = new Set(
        (useCanvasStore.getState().messagesByConv[id] ?? []).flatMap((m) =>
          (m.attachments ?? []).map((a) => a.payload)
        )
      );
      const added: PendingAttachment[] = [];
      for (const n of mediaSources) {
        // 「连接」模式边（inject:false，仅连线不注入）已在上游 filter 排除
        if (prev.some((a) => a.sourceNodeId === n.id)) continue;
        const md = n.data as unknown as MediaData;
        const payload = md.kind === "image" ? (md.thumb ?? "") : (md.body ?? "");
        if (sentPayloads.has(payload)) continue;
        added.push({
          id: crypto.randomUUID(),
          kind: md.kind ?? "file",
          payload,
          mime: md.mime ?? "",
          filename: md.name,
          sourceNodeId: n.id,
          parseFailed: md.parseFailed,
        });
      }
      return added.length ? [...prev, ...added] : prev;
    });
  }, [id, mediaSources]);

  // 拖线引用消费：text/media 节点拖线到本对话 → 输入框出现 @标签（媒体同步进托盘），边在发送时自动建立
  const pendingMentions = useCanvasStore((s) => s.pendingMentionsByConv[id] ?? EMPTY_PENDING);
  useEffect(() => {
    if (pendingMentions.length === 0) return;
    const store = useCanvasStore.getState();
    for (const nodeId of pendingMentions) {
      const node = store.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      // 媒体（图片/文件）连线：只进待发送托盘，**不在输入框出现 @标签**（图片靠托盘附件注入，
      // 无文本占位；text/search 引用才用 @标签 就地替换）
      if (node.type === "media") {
        const md = node.data as unknown as MediaData;
        // 同源节点已在托盘则不重复进（拖线/picker 可能重复触发同一节点）
        setAttachments((prev) =>
          prev.some((a) => a.sourceNodeId === node.id)
            ? prev
            : [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  kind: md.kind,
                  payload: md.kind === "image" ? (md.thumb ?? "") : (md.body ?? ""),
                  mime: md.mime,
                  filename: md.name,
                  sourceNodeId: node.id,
                  parseFailed: md.parseFailed,
                },
              ]
        );
        continue;
      }
      const mentionText = `@${mentionTextOf(node)}`;
      setInput((prev) => (prev ? prev + " " : "") + mentionText + " ");
      setMentions((prev) => [...prev, { nodeId, text: mentionText }]);
    }
    store.clearPendingMentions(id);
  }, [pendingMentions, id]);

  // 拖线已注入节点 → 弹「连接 / 再次注入」确认菜单（已注入不静默重复）
  const pendingConfirm = useCanvasStore((s) => s.pendingConfirmByConv[id] ?? EMPTY_PENDING);
  const [confirmMenu, setConfirmMenu] = useState<{ nodeId: string; label: string } | null>(null);
  const confirmMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pendingConfirm.length === 0) return;
    const store = useCanvasStore.getState();
    const node = store.nodes.find((n) => n.id === pendingConfirm[0]);
    if (!node) {
      store.clearPendingConfirm(id);
      return;
    }
    setConfirmMenu({ nodeId: node.id, label: `@${mentionTextOf(node)}` });
  }, [pendingConfirm, id]);
  // 点击菜单外 → 放弃本次拖线确认
  useEffect(() => {
    if (!confirmMenu) return;
    const close = (e: MouseEvent) => {
      if (confirmMenuRef.current && !confirmMenuRef.current.contains(e.target as Node)) {
        setConfirmMenu(null);
        useCanvasStore.getState().clearPendingConfirm(id);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [confirmMenu, id]);

  const clearAttachments = () => setAttachments([]);

  const handleSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    setInput("");
    const atts = attachments;
    const mts = mentions;
    clearAttachments();
    setMentions([]);
    void send(id, text, atts, mts);
  };

  // ===== 附件输入：粘贴 / 拖拽 / 选择文件（临时附件通道） =====

  // 卸载守卫：FileReader 异步回调不再 setState（切换画布/删节点后回调迟到属脏更新）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const addImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!mountedRef.current) return;
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), kind: "image", payload: reader.result as string, mime: file.type, filename: file.name },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const addTextFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!mountedRef.current) return;
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), kind: "file", payload: reader.result as string, mime: file.type, filename: file.name },
      ]);
    };
    reader.onerror = () => {
      if (!mountedRef.current) return;
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), kind: "file", payload: "", mime: file.type, filename: file.name, parseFailed: true },
      ]);
    };
    reader.readAsText(file);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFile(file);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      if (file.type.startsWith("image/")) addImageFile(file);
      else addTextFile(file);
    }
  };

  const handleAttachmentRemove = (attId: string) => {
    const att = attachments.find((a) => a.id === attId);
    if (!att) return;
    if (att.sourceNodeId) {
      // 取消引用 = 断开边
      const edge = useCanvasStore
        .getState()
        .edges.find((e) => e.target === id && e.source === att.sourceNodeId);
      if (edge) useCanvasStore.getState().onEdgesChange([{ type: "remove", id: edge.id }]);
    }
    setAttachments((prev) => prev.filter((a) => a.id !== attId));
  };

  const handlePin = (att: PendingAttachment) => {
    if (att.sourceNodeId) return;
    const { nodes } = useCanvasStore.getState();
    const convNode = nodes.find((n) => n.id === id);
    if (!convNode) return;
    const mediaId = crypto.randomUUID();
    // 对话节点左侧，自适应避开已有节点（避免与既有媒体节点重叠）
    const spot = findFreeSpot(
      nodes,
      { x: convNode.position.x - 310, y: convNode.position.y },
      { w: 260, h: 240 }
    );
    addNode({
      id: mediaId,
      type: "media",
      position: spot,
      data: toMediaData(att),
    });
    addEdge({
      id: crypto.randomUUID(),
      source: mediaId,
      target: id,
      sourceHandle: null,
      targetHandle: null,
    });
    setAttachments((prev) => prev.filter((a) => a.id !== att.id));
  };

  // ===== @ 提及（反向：手动 @ → 自动建边） =====

  const handlePickerPick = (node: FlowNode) => {
    if (node.type === "media") {
      const md = node.data as unknown as MediaData;
      // 同源节点已在托盘则不重复进（picker 选中后 useEffect 按边再进会重复）
      setAttachments((prev) =>
        prev.some((a) => a.sourceNodeId === node.id)
          ? prev
          : [
              ...prev,
              {
                id: crypto.randomUUID(),
                kind: md.kind,
                payload: md.kind === "image" ? (md.thumb ?? "") : (md.body ?? ""),
                mime: md.mime,
                filename: md.name,
                sourceNodeId: node.id,
                parseFailed: md.parseFailed,
              },
            ]
      );
    }
    addEdge({
      id: crypto.randomUUID(),
      source: node.id,
      target: id,
      sourceHandle: null,
      targetHandle: null,
    });
    // 输入框插入可见 @显示名（替换 @ 到当前光标之间的过滤词），并记录提及映射供发送时就地替换
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const insertAt = Math.min(Math.max(atIdx, 0), input.length);
    const end = Math.max(caret, insertAt);
    const mentionText = `@${mentionTextOf(node)}`;
    setInput((prev) => prev.slice(0, insertAt) + mentionText + prev.slice(end));
    setMentions((prev) => [...prev, { nodeId: node.id, text: mentionText }]);
    // 光标移到插入文本之后，方便继续输入
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const pos = insertAt + mentionText.length;
        ta.setSelectionRange(pos, pos);
      }
    });
    setPicker(null);
    setAtIdx(-1);
  };

  // 删除输入框内 @提及 标签：按命中实例精确位置移除（重复 @提及 时不错位）。
  // 取消引用：仅未消费（虚线待发送）的引用边自动断开；已消费（历史实线边，如「再次注入」）
  // 只删 @标签 文本、不断边（连接后不可手动断开）；media 附件同步从托盘移除
  const removeMention = (seg: MentionSeg) => {
    const nodeId = seg.mention?.nodeId;
    const start = seg.start;
    setInput((prev) => prev.slice(0, start) + prev.slice(start + seg.text.length));
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start, start);
      }
    });
    setMentions((prev) => prev.filter((x) => x !== seg.mention));
    if (!nodeId) return;
    const store = useCanvasStore.getState();
    const consumed = isAssetConsumed(store.messagesByConv[id] ?? [], nodeId);
    if (consumed) return; // 已消费边不可断开（仅移除 @标签 文本）
    const edge = store.edges.find((e) => e.target === id && e.source === nodeId);
    if (edge) store.onEdgesChange([{ type: "remove", id: edge.id }]);
    // media 引用：托盘附件一并移除（取消引用 = 完全取消，与 handleAttachmentRemove 语义对称）
    setAttachments((prev) => prev.filter((a) => a.sourceNodeId !== nodeId));
  };

  // ===== 文本提取（划词右键，） =====

  const [selMenu, setSelMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    if (!selMenu) return;
    const close = () => setSelMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [selMenu]);

  const handleMessagesCtx = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = nodeRef.current?.getBoundingClientRect();
    setSelMenu({
      x: rect ? e.clientX - rect.left : e.clientX,
      y: rect ? e.clientY - rect.top : e.clientY,
      text,
    });
  };

  const extractToTextNode = () => {
    if (!selMenu) return;
    const { nodes } = useCanvasStore.getState();
    const convNode = nodes.find((n) => n.id === id);
    if (!convNode) return;
    const textNodeId = crypto.randomUUID();
    const title = prefix(selMenu.text, 16) || "文本";
    // 画布内文本节点：不落 `.md`，正文随 .atlx 内嵌（右键「保存为笔记」才生成仓库笔记文件）
    // 对话节点右侧，自适应避开已有节点
    const spot = findFreeSpot(
      nodes,
      { x: convNode.position.x + 480, y: convNode.position.y },
      { w: 320, h: 240 }
    );
    addNode({
      id: textNodeId,
      type: "text",
      position: spot,
      // 显式写入默认尺寸（与 addTextNoteFromVault 一致，避免依赖 TextNode 的 ?? 回退）
      width: DEFAULT_TEXT_NODE_WIDTH,
      height: DEFAULT_TEXT_NODE_HEIGHT,
      data: { title, bodyMd: selMenu.text },
    });
    addEdge({
      id: crypto.randomUUID(),
      source: id,
      target: textNodeId,
      sourceHandle: null,
      targetHandle: null,
    });
    setSelMenu(null);
  };

  // ===== 历史图片拉出为媒体节点（与文本提取对称） =====

  const extractToMediaNode = useCallback((att: Attachment) => {
    const { nodes } = useCanvasStore.getState();
    const convNode = nodes.find((n) => n.id === id);
    if (!convNode) return;
    const mediaId = crypto.randomUUID();
    // 对话节点右侧，自适应避开已有节点
    const spot = findFreeSpot(
      nodes,
      { x: convNode.position.x + 480, y: convNode.position.y },
      { w: 260, h: 240 }
    );
    addNode({
      id: mediaId,
      type: "media",
      position: spot,
      data: {
        mime: att.mime,
        kind: att.kind,
        name: att.filename,
        thumb: att.kind === "image" ? att.payload : undefined,
        body: att.kind === "file" ? att.payload : undefined,
      },
    });
    addEdge({
      id: crypto.randomUUID(),
      source: id,
      target: mediaId,
      sourceHandle: null,
      targetHandle: null,
    });
  }, [id, addNode, addEdge]);

  // ===== 分支：以点击消息（含）之前的全部完整状态创建子对话节点 =====
  // 分支按钮挂在每条消息气泡下方；父子间仅一条血缘边，无数据交互。
  const handleBranch = useCallback((messageId: string) => {
    const { nodes } = useCanvasStore.getState();
    const convNode = nodes.find((n) => n.id === id);
    if (!convNode) return;
    // 子节点落在父节点右侧，自适应避开已有节点（对话节点默认宽 ~480）
    const spot = findFreeSpot(
      nodes,
      { x: convNode.position.x + DEFAULT_CONVERSATION_WIDTH + 40, y: convNode.position.y },
      { w: DEFAULT_CONVERSATION_WIDTH, h: DEFAULT_CONVERSATION_HEIGHT }
    );
    void branchFrom(id, messageId, spot);
    // 聚焦到新节点，避免落在视野外
    setTimeout(() => fitView({ duration: 200, padding: 0.2 }), 60);
  }, [id, branchFrom, fitView]);

  // 点击 user 消息气泡里的 @chip → 定位视图到引用的源节点
  const handleLocateRef = useCallback((nodeId: string) => {
    fitView({ nodes: [{ id: nodeId }], duration: 200, padding: 0.2 });
  }, [fitView]);

  // [[wiki 链接]] 定位 + 笔记链接打开/新建（公共接线簇，见 hooks/useWikiNodeLocate、useVaultLinkHandlers）
  const { isWikiLocatable, handleLocateWiki } = useWikiNodeLocate();
  const { handleOpenWikiNote, isVaultPathNote, handleOpenVaultPathNote, handleCreateNote } =
    useVaultLinkHandlers();

  // ===== 渲染 =====

  // assistant 消息的 Markdown 组件配置：useMemo 稳定化（气泡 memo 生效前提，流式期间历史消息不重渲染）
  const messageMarkdownComponents = useMemo(
    () =>
      markdownComponents({
        isLocatable: isWikiLocatable,
        onLocate: handleLocateWiki,
        onOpenNote: handleOpenWikiNote,
        isVaultPathNote,
        onOpenVaultPathNote: handleOpenVaultPathNote,
        onCreateNote: handleCreateNote,
        onOpenUrl: (url) => void useAppStore.getState().openUrl(url),
      }),
    [isWikiLocatable, handleLocateWiki, handleOpenWikiNote, isVaultPathNote, handleOpenVaultPathNote, handleCreateNote]
  );
  const handleRollback = useCallback(
    (messageId: string) => rollbackTo(id, messageId),
    [id, rollbackTo]
  );
  // @chip 点击定位（稳定引用，气泡 memo 生效前提）
  const handleRefChipClick = useCallback(
    (refKey: string) => handleLocateRef(refKey),
    [handleLocateRef]
  );

  const last = messages[messages.length - 1];
  const canRegenerate =
    !!last && last.role === "assistant" && !streaming && !last.content.startsWith("[错误]");
  // 输入框 overlay 分段：@提及 → 圆角标签段（可删除），其余普通文本段
  const segments = splitMentions(input, mentions);

  return (
    <div
      ref={nodeRef}
      className="rounded-lg shadow-lg border flex flex-col text-sm"
      style={{
        width: width ?? 420,
        height: height ?? undefined,
        minWidth: 280,
        minHeight: 150,
        background: "var(--bg-card)",
        borderColor: "var(--border)",
        cursor: "default",
        position: "relative",
      }}
    >
      <ConnectionFrame topType="target" />

      <header
        className="px-3 py-2 border-b rounded-t-lg flex items-center gap-2"
        style={{
          cursor: "grab",
          borderColor: "var(--border)",
          background: "var(--bg-card)",
        }}
      >
        {/* 标题：双击 inline 编辑（nodrag + stopPropagation 防触发节点拖拽） */}
        {titleEdit.editing ? (
          <input
            {...titleEdit.inputProps}
            autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="对话"
            className="nodrag font-medium text-sm min-w-0 w-32 bg-transparent border-b border-[var(--accent)] outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              titleEdit.start();
            }}
            title="双击重命名"
            className="font-medium truncate max-w-[150px] min-w-0 flex-shrink cursor-text"
            style={{ color: "var(--text-primary)" }}
          >
            {displayTitle}
          </span>
        )}
        {streaming && (
          <span className="text-xs text-[var(--accent)] flex-shrink-0 inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin flex-shrink-0" />生成中
          </span>
        )}

        {/* 供应商·模型选择：节点指定优先（一步定下 provider + model），留空 = 跟随仓库默认 */}
        <div className="ml-auto flex items-center gap-1 nodrag" onClick={(e) => e.stopPropagation()}>
          {/* 联网搜索工具开关：开启后 AI 自主决定联网搜索（需搜索源已配置，未配置发送时提示） */}
          <button
            onClick={() => updateNodeData(id, { toolsEnabled: !nodeData?.toolsEnabled })}
            title={
              nodeData?.toolsEnabled
                ? "联网搜索：已开启（AI 可自主联网搜索）"
                : "联网搜索：关闭（点击开启）"
            }
            aria-label="联网搜索工具"
            className="nodrag rounded px-1 py-0.5 hover:opacity-80"
            style={{ color: nodeData?.toolsEnabled ? "var(--accent)" : "var(--text-muted)" }}
          >
            <Globe size={13} className="flex-shrink-0" />
          </button>
          {/* 系统提示词：选择已标记的提示词笔记，发送时注入 system 消息（留空 = 不注入），样式与模型选择一致 */}
          <DropdownSelect
            value={sysPromptFile ?? ""}
            onChange={(v) => updateNodeData(id, { systemPromptFile: v || undefined })}
            options={[
              { value: "", label: "提示词" },
              ...promptNotes.map((n) => ({
                value: n.file,
                label: n.name.replace(/\.md$/i, ""),
              })),
            ]}
            className="nodrag text-xs rounded px-1 py-0.5 w-24"
            style={{
              color: "var(--text-secondary)",
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
            }}
            title="选择系统提示词（右键笔记注册，留空 = 不注入）"
          />
          <DropdownSelect
            value={comboOptions.some((o) => o.key === currentComboKey) ? currentComboKey : ""}
            onChange={(v) => {
              if (!v) {
                // 留空 = 全部跟随仓库默认（清空节点级指定）
                updateNodeData(id, { providerId: "", model: "" });
                return;
              }
              const combo = comboOptions.find((o) => o.key === v);
              if (combo) updateNodeData(id, { providerId: combo.providerId, model: combo.model });
            }}
            options={[
              { value: "", label: defaultModelDisplay ?? "模型" },
              // 按供应商分组（组头 = 供应商名），模型显示昵称/原名
              ...comboOptions.map((o) => ({
                value: o.key,
                label: o.label,
                group: o.group,
              })),
            ]}
            className="nodrag text-xs rounded px-1 py-0.5 w-24"
            style={{
              color: "var(--text-secondary)",
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
            }}
            title="选择供应商与模型（留空 = 跟随默认）"
          />
        </div>
      </header>

      {error && (
        <div
          className="nodrag px-3 py-1.5 text-xs flex items-center justify-between"
          style={{
            background: "#7f1d1d",
            color: "#fca5a5",
            userSelect: "text",
            WebkitUserSelect: "text",
          }}
        >
          <span>{error}</span>
          <button onClick={clearError} className="ml-2 hover:opacity-80"><X size={12} /></button>
        </div>
      )}

      <div className={`relative ${hasFixedHeight ? "flex-1 min-h-0 flex flex-col" : ""}`}>
        <div
          ref={scrollRef}
          className={`nodrag nowheel overflow-auto px-3 pt-2 pb-6 space-y-3 ${hasFixedHeight ? 'flex-1 min-h-0' : 'max-h-[300px]'}`}
          onScroll={handleScroll}
          onContextMenu={handleMessagesCtx}
        >
        {messages.length === 0 ? (
          <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>输入消息开始对话</p>
        ) : (
          messages.map((m, i) => {
            // 进行中的最后一条消息（流式占位/未完成）不显示分支按钮：「完整状态」语义
            const isStreamingMsg = streaming && i === messages.length - 1;
            // 分支按钮仅在 AI 回复处显示（用户消息不分支）：以该 AI 回复（含）之前的完整状态创建子节点
            const canBranch =
              m.role === "assistant" && m.content.trim() !== "" && !isStreamingMsg;
            return (
              <ChatMessageBubble
                key={m.id}
                role={m.role === "user" ? "user" : "assistant"}
                displayContent={m.role === "user" ? m.displayContent ?? m.content : undefined}
                refs={m.refs}
                refKeyOf={refKeyOfNodeRef}
                onRefChipClick={handleRefChipClick}
                content={m.content}
                reasoningContent={m.reasoningContent}
                isStreaming={isStreamingMsg}
                attachments={m.attachments}
                onMediaExtract={extractToMediaNode}
                markdownComponents={messageMarkdownComponents}
                copyText={m.role === "user" ? (m.displayContent ?? m.content) : m.content}
                messageId={m.id}
                canRollback={canBranch}
                onRollback={handleRollback}
                onBranch={canBranch ? handleBranch : undefined}
                userBubbleClass="bg-[var(--accent)] text-[var(--accent-fg)]"
                stopPropagation
              />
            );
          })
        )}

        {canRegenerate && (
          <div className="flex justify-end">
            <button
              onClick={() => void regenerate(id)}
              className="text-xs px-2 py-0.5 rounded border hover:opacity-80 inline-flex items-center gap-1"
              style={{ color: "var(--text-secondary)", borderColor: "var(--border)", background: "var(--bg-tertiary)" }}
              title="重新生成最后一条回复"
            >
              <RefreshCw size={12} className="flex-shrink-0" /> 重新生成
            </button>
          </div>
        )}
        </div>
        {showJumpToBottom && <JumpToBottomButton onClick={jumpToBottom} className="nodrag" />}
      </div>

      {/* 划词浮动菜单（文本提取） */}
      {selMenu && (
        <div
          className="absolute z-50 border rounded shadow-lg py-1 w-44"
          style={{
            left: selMenu.x,
            top: selMenu.y,
            background: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={extractToTextNode}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] inline-flex items-center gap-1.5"
            style={{ color: "var(--text-primary)" }}
          >
            <Scissors size={14} className="flex-shrink-0" /> 拉出为文本节点
          </button>
          <button
            onClick={() => setSelMenu(null)}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            取消
          </button>
        </div>
      )}

      {/* @ 提及选择器 */}
      {picker && (
        <ConversationAtPicker
          conversationId={id}
          x={picker.x}
          y={picker.y}
          openUp={picker.openUp}
          yBottom={picker.yBottom}
          query={picker.query}
          onPick={handlePickerPick}
          onClose={() => setPicker(null)}
        />
      )}

      {confirmMenu && (
        <div
          ref={confirmMenuRef}
          className="absolute z-50 border rounded shadow-lg py-1 w-56"
          style={{
            left: 12,
            bottom: 58,
            background: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-xs truncate" style={{ color: "var(--text-muted)" }}>
            「{confirmMenu.label}」已在历史消息中注入过
          </div>
          <button
            onClick={() => {
              useCanvasStore.getState().confirmConnect(id, confirmMenu.nodeId);
              setConfirmMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] flex items-center gap-1.5"
            style={{ color: "var(--text-primary)" }}
          >
            <RefreshCw size={14} className="flex-shrink-0" />
            再次注入
          </button>
        </div>
      )}

      <ConversationAttachmentTray
        attachments={attachments}
        onRemove={handleAttachmentRemove}
        onPin={handlePin}
      />

      <div
        className="nodrag border-t p-2 flex gap-2"
        style={{ borderColor: "var(--border)" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            for (const file of files) {
              if (file.type.startsWith("image/")) addImageFile(file);
              else addTextFile(file);
            }
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2 rounded text-sm nodrag hover:opacity-80"
          style={{ color: "var(--text-secondary)", background: "var(--bg-tertiary)" }}
          title="添加附件（Ctrl+V 粘贴图片 / 拖拽文件）"
        >
          <Plus size={16} />
        </button>
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <MentionTextarea
            textareaRef={textareaRef}
            value={input}
            onChange={(v) => {
              setInput(v);
              // @ 后继续输入 → 实时过滤候选（query = @ 位置之后的内容）
              if (picker && atIdx >= 0) {
                setPicker((p) => (p ? { ...p, query: v.slice(atIdx + 1) } : p));
              }
            }}
            segments={segments}
            onRemoveMention={removeMention}
            onKeyDown={(e) => {
              if (e.key === "@") {
                setAtIdx(textareaRef.current?.selectionStart ?? 0);
                const taRect = textareaRef.current?.getBoundingClientRect();
                const nodeRect = nodeRef.current?.getBoundingClientRect();
                // 节点内相对坐标（菜单 absolute 定位，避免 React Flow transform 容器下 fixed 漂移）
                const x = (taRect?.left ?? 0) - (nodeRect?.left ?? 0);
                const y = (taRect?.bottom ?? 0) - (nodeRect?.top ?? 0);
                const yBottom = (nodeRect?.bottom ?? 0) - (taRect?.bottom ?? 0);
                // 下方视口空间不足（估算菜单高 ~264）→ 向上弹出
                const openUp = (window.innerHeight - (taRect?.bottom ?? 0)) < 264;
                setPicker({ x, y, openUp, yBottom, query: "" });
              }
              // IME 组合期间 Enter 是「上屏候选词」而非发送（中文输入法必踩，防半成品拼音发送）
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={handlePaste}
            placeholder="输入消息…（@ 引用画布资产，Shift+Enter 换行）"
            rows={2}
            backgroundLayer={<div className="absolute inset-0 rounded" style={{ background: "var(--input-bg)" }} />}
            overlayClassName="z-10 rounded px-2 py-1 text-sm"
            textareaClassName="relative w-full h-full rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)] nodrag nowheel overflow-y-auto"
          />
        </div>
        {streaming ? (
          <button
            onClick={() => abort(id)}
            className="px-3 rounded text-xs nodrag"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-secondary)",
            }}
          >
            停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            className="px-3 rounded bg-[var(--accent)] text-[var(--accent-fg)] text-xs hover:bg-[var(--accent-hover)] nodrag"
          >
            发送
          </button>
        )}
      </div>

      <NodeResizeControl
        position="bottom-right"
        style={{
          width: 10,
          height: 10,
          background: "#fff",
          border: "2px solid #d4af37",
          borderRadius: 2,
          cursor: "nwse-resize",
        }}
      />
    </div>
  );
}

