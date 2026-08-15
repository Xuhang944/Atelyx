import { Image, StickyNote, Table as TableIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import type { Node as FlowNode } from "@xyflow/react";
import type { TableData, TextData, MediaData, SearchResultData } from "@/types";
import { mentionTextOf } from "@/utils/text";
import { useDismissOnOutside } from "@/hooks/useDismissOnOutside";

/**
 * @ 提及选择器（反向：手动 @ → 自动建边 + @chip）。
 * 列出画布上未被该对话引用的 text / media 节点；@ 后继续输入按内容实时过滤。
 * 键盘：↑/↓ 移动高亮、Enter 确认、Esc 关闭（document 捕获阶段拦截，避免 Enter 误发送）。
 * 选择后：text 建边（进 @chips）；media 建边（由调用方加入待发送托盘）。
 */

interface Props {
  conversationId: string;
  x: number;
  y: number;
  /** 向上弹出模式：菜单底边到输入框底边的节点内距离 */
  openUp: boolean;
  yBottom: number;
  /** @ 后已输入的过滤词（@ 字符未插入输入框，query = 触发后新输入内容） */
  query: string;
  onPick: (node: FlowNode) => void;
  onClose: () => void;
}

export function ConversationAtPicker({ conversationId, x, y, openUp, yBottom, query, onPick, onClose }: Props) {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // active 供键盘监听读取（ref 避免监听随 active 每击键重绑）
  const activeRef = useRef(active);
  activeRef.current = active;

  // 已引用（含 media 连边）的源节点不重复列出（useMemo 稳定引用，避免监听每渲染重绑）
  const referenced = useMemo(
    () => new Set(edges.filter((e) => e.target === conversationId).map((e) => e.source)),
    [edges, conversationId]
  );

  // @ 后输入过滤：文本按正文+标题、媒体按文件名（忽略大小写包含匹配）。空正文文本节点也可检索（显示名回退标题）
  const q = query.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      nodes.filter((n) => {
        if (referenced.has(n.id)) return false;
        if (n.type === "text") {
          const d = n.data as unknown as TextData;
          const haystack = `${d.bodyMd ?? ""}\n${d.title ?? ""}`.toLowerCase();
          return q === "" || haystack.includes(q);
        }
        if (n.type === "media") {
          const name = (n.data as unknown as MediaData).name ?? "";
          return q === "" || name.toLowerCase().includes(q);
        }
        if (n.type === "search") {
          // 搜索结果节点可被 @提及（复用）
          const query = (n.data as unknown as SearchResultData).query ?? "";
          return q === "" || query.toLowerCase().includes(q);
        }
        if (n.type === "table") {
          // 表格节点可被 @提及（快照注入对话上下文）
          const d = n.data as unknown as TableData;
          const haystack = `${d.title ?? ""}\n${d.snapshot ?? ""}`.toLowerCase();
          return q === "" || haystack.includes(q);
        }
        return false;
      }),
    [nodes, referenced, q]
  );

  // 过滤词/候选变化时高亮回到第一项
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 候选收缩（画布删节点/连边导致 referenced 变化）时高亮越界兜底：回退到末项
  useEffect(() => {
    setActive((i) => (candidates.length ? Math.min(i, candidates.length - 1) : 0));
  }, [candidates.length]);

  // 点击菜单外关闭（公共 hook；Esc 由下方捕获阶段键盘监听处理，hook 的 window Esc 为兜底，onClose 幂等）
  useDismissOnOutside(onClose, ref);

  // 键盘导航：捕获阶段拦截，防止输入框的 Enter 发送 / 方向键默认行为
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (candidates.length ? (i + 1) % candidates.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (candidates.length ? (i - 1 + candidates.length) % candidates.length : 0));
      } else if (e.key === "Enter") {
        // IME 组合期间 Enter 是上屏候选词，不触发选择（中文输入法必踩）
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        const n = candidates[activeRef.current];
        if (n) onPick(n);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [candidates, onPick, onClose]);

  // 节点内 absolute 定位（节点根 div 是 position: relative；避免 React Flow transform 容器下 fixed 漂移）
  const style: React.CSSProperties = openUp
    ? { left: x, bottom: yBottom + 6 }
    : { left: x, top: y + 6 };

  const labelOf = (n: FlowNode): { label: ReactNode; full: string } => {
    if (n.type === "text") {
      return {
        label: (
          <span className="inline-flex items-center gap-1">
            <StickyNote size={14} className="flex-shrink-0" />
            {mentionTextOf(n)}
          </span>
        ),
        full: (n.data as unknown as TextData).bodyMd ?? "",
      };
    }
    if (n.type === "table") {
      return {
        label: (
          <span className="inline-flex items-center gap-1">
            <TableIcon size={14} className="flex-shrink-0" />
            {mentionTextOf(n)}
          </span>
        ),
        full: (n.data as unknown as TableData).title ?? "",
      };
    }
    const md = n.data as unknown as MediaData;
    return {
      label: (
        <span className="inline-flex items-center gap-1">
          <Image size={14} className="flex-shrink-0" />
          {mentionTextOf(n)}
        </span>
      ),
      full: md.name ?? "",
    };
  };

  return (
    <div
      ref={ref}
      className="absolute z-50 border rounded shadow-lg py-1 w-64 max-h-64 overflow-auto nowheel"
      style={{ ...style, background: "var(--bg-secondary)", borderColor: "var(--border)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {candidates.length === 0 ? (
        <div className="px-3 py-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
          无匹配资产
        </div>
      ) : (
        candidates.map((n, i) => {
          const { label, full } = labelOf(n);
          const isActive = i === active;
          return (
            <button
              key={n.id}
              onClick={() => onPick(n)}
              onMouseEnter={() => setActive(i)}
              className="w-full text-left px-3 py-1.5 text-sm block"
              style={{
                color: isActive ? "#fff" : "var(--text-primary)",
                background: isActive ? "var(--accent)" : undefined,
              }}
              title={full}
            >
              <span className="truncate block">{label}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
