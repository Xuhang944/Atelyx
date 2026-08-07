/**
 * 搜索面板（左侧边栏，ActivityBar「搜索」图标切换）。
 *
 * 多搜索模式框架：顶部下拉选择模式（「按文件名」当前可用；「全局搜索」「按标签搜索」
 * 占位禁用「尚未支持」）。当前仅实现「按文件名」：输入即实时过滤全仓库文件名
 * （不区分大小写子串匹配，内存过滤无 debounce），结果扁平行点击打开画布/笔记
 * （与文件面板单击行为一致，附件不可点）。
 *
 * 分层：走 `vaultStore`（文件树）+ `appStore`（画布行）+ props 回调打开文件。
 */
import { Check, ChevronDown, FileText, LayoutDashboard, Paperclip, Search, StickyNote, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { useAppStore } from "@/stores/appStore";
import { useVaultStore } from "@/stores/vaultStore";
import { VaultSwitcher } from "@/components/canvas/panels/VaultSwitcher";
import { parentDir } from "@/utils/filename";
import type { CanvasFileRow, FileTreeNode } from "@/types";

/** 搜索模式列表：当前仅「按文件名」支持，其余为后续模式占位。 */
const SEARCH_MODES: { key: string; label: string; supported: boolean }[] = [
  { key: "filename", label: "按文件名", supported: true },
  { key: "global", label: "全局搜索", supported: false },
  { key: "tag", label: "按标签搜索", supported: false },
];

/** 从 `.md` 文件名还原显示标题：仅去 `.md` 后缀。 */
function noteTitleFromName(name: string): string {
  return name.replace(/\.md$/i, "");
}

/** 递归收集树中全部文件（搜索结果扁平行）。 */
function collectFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const n of nodes) {
    if (n.isDir) out.push(...collectFiles(n.children));
    else out.push(n);
  }
  return out;
}

interface SearchPanelProps {
  /** 单击画布结果行：打开画布并激活画布窗口（与文件面板同一入口）。 */
  onOpenCanvasFile: (row: CanvasFileRow) => void;
  /** 单击 `.md` 结果行：打开笔记窗口。 */
  onOpenNoteForEdit: (file: string, title: string) => void;
}

export function SearchPanel({ onOpenCanvasFile, onOpenNoteForEdit }: SearchPanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const canvases = useAppStore((s) => s.canvases);

  const [mode, setMode] = useState(SEARCH_MODES[0].key);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // 模式下拉气泡（顶部按钮触发，同文件面板排序菜单写法）
  const [modeMenu, setModeMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** 文件名过滤：不区分大小写子串匹配，命中全部文件类型（附件仅展示不可点）。 */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return collectFiles(tree).filter((f) => f.name.toLowerCase().includes(q));
  }, [tree, query]);

  /** 单击结果行：画布/白板/笔记打开（同文件面板），附件无动作。 */
  const openResult = (node: FileTreeNode) => {
    if (node.name.toLowerCase().endsWith(".atlx")) {
      const row = canvases.find((c) => c.file === node.path);
      if (row) onOpenCanvasFile(row);
    } else if (node.name.toLowerCase().endsWith(".canvas")) {
      // 外部白板：合成行打开（只读查看）
      onOpenCanvasFile({
        id: node.path,
        title: node.name.replace(/\.canvas$/i, ""),
        file: node.path,
        updatedAt: node.updatedAt,
      });
    } else if (node.name.toLowerCase().endsWith(".md")) {
      onOpenNoteForEdit(node.path, noteTitleFromName(node.name));
    }
  };

  const modeLabel = SEARCH_MODES.find((m) => m.key === mode)?.label ?? "";

  return (
    <div
      className="h-full flex flex-col text-sm overflow-hidden"
      style={{ background: "var(--bg-secondary)", color: "var(--text-primary)" }}
    >
      {/* 顶部：模式选择 + 搜索输入框 */}
      <div className="px-2 py-1.5 border-b flex flex-col gap-1.5" style={{ borderColor: "var(--border)" }}>
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setModeMenu({ x: rect.right, y: rect.bottom });
          }}
          className="flex items-center gap-1 w-fit px-1.5 py-0.5 rounded hover:bg-[var(--hover)] text-xs"
          style={{ color: "var(--text-secondary)" }}
          title="搜索模式"
        >
          <Search size={12} />
          <span>{modeLabel}</span>
          <ChevronDown size={12} />
        </button>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ background: "var(--bg-tertiary)" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="搜索文件名…"
            className="flex-1 bg-transparent outline-none text-xs min-w-0"
            style={{ color: "var(--text-primary)" }}
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="flex-shrink-0 p-0.5 rounded hover:bg-[var(--hover)]"
              style={{ color: "var(--text-muted)" }}
              title="清空"
              aria-label="清空搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-auto py-1">
        {!query.trim() ? (
          <div className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
            输入关键词，按文件名搜索仓库文件
          </div>
        ) : results.length === 0 ? (
          <div className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
            无匹配结果
          </div>
        ) : (
          results.map((node) => {
            const isCanvas = node.name.toLowerCase().endsWith(".atlx");
            const isWhiteboard = node.name.toLowerCase().endsWith(".canvas");
            const isNote = node.name.toLowerCase().endsWith(".md");
            // 附件不可点：光标 default（与文件面板一致）；画布/白板/笔记可点打开
            const clickable = isCanvas || isWhiteboard || isNote;
            return (
              <div
                key={node.path}
                className="flex items-center gap-1 px-2 py-1 min-h-8 hover:bg-[var(--hover)]"
                style={{ cursor: clickable ? "pointer" : "default" }}
                onClick={() => openResult(node)}
                title={clickable ? `打开 ${node.name}` : undefined}
              >
                {isCanvas ? (
                  <FileText size={14} style={{ color: "var(--text-muted)" }} />
                ) : isWhiteboard ? (
                  <LayoutDashboard size={14} style={{ color: "var(--text-muted)" }} />
                ) : isNote ? (
                  <StickyNote size={14} style={{ color: "var(--text-muted)" }} />
                ) : (
                  <Paperclip size={14} style={{ color: "var(--text-muted)" }} />
                )}
                <span className="flex-1 truncate text-xs" style={{ color: "var(--text-primary)" }}>{node.name}</span>
                {node.path !== node.name && (
                  <span className="text-[10px] truncate max-w-[45%] flex-shrink-0" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
                    {parentDir(node.path)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 面板底部：仓库切换条（与文件面板一致） */}
      <div className="flex-shrink-0 border-t" style={{ borderColor: "var(--border)" }}>
        <VaultSwitcher />
      </div>

      {/* 模式下拉气泡（点击外部/Esc 关闭，当前模式打勾，未支持模式灰显） */}
      {modeMenu && (
        <ModeMenu
          x={modeMenu.x}
          y={modeMenu.y}
          value={mode}
          onChange={(k) => {
            setMode(k);
            setModeMenu(null);
          }}
          onClose={() => setModeMenu(null)}
        />
      )}
    </div>
  );
}

/** 搜索模式下拉气泡。 */
function ModeMenu({
  x,
  y,
  value,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  value: string;
  onChange: (key: string) => void;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 挂载后按菜单实测尺寸钳制到视口内（防靠近窗口右/下边缘被截断）
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // menuRef 为稳定引用（hook 内 useRef），加入依赖仅为消除 exhaustive-deps，不会重挂监听
  }, [menuRef]);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-40"
      style={{
        left: pos.x,
        top: pos.y,
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
        color: "var(--text-primary)",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {SEARCH_MODES.map((m) => (
        <button
          key={m.key}
          disabled={!m.supported}
          onClick={() => onChange(m.key)}
          className="w-full text-left px-3 py-1.5 text-sm inline-flex items-center gap-1.5 disabled:cursor-not-allowed"
          style={{
            color: m.supported ? "var(--text-primary)" : "var(--text-muted)",
            opacity: m.supported ? 1 : 0.6,
          }}
        >
          <span className="flex-1">{m.label}</span>
          {m.supported ? (
            value === m.key && <Check size={12} style={{ color: "var(--accent)" }} />
          ) : (
            <span className="text-[10px]">尚未支持</span>
          )}
        </button>
      ))}
    </div>
  );
}
