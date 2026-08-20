/**
 * 仓库文件管理面板（全仓库树）。
 *
 * 工作区左栏，树状展示仓库内全部文件夹与文件（跳过隐藏 `.` 开头目录与排除文件夹，
 * 见 `.atelyx/config.json` 的 `excludeFolders`），支持展开折叠、排序下拉、
 * 文件夹行右键新建（画布 / 笔记 / 文件夹，inline 输入框 Enter 创建，落该文件夹；
 * 文件树空白处右键 = 落仓库根目录）+ 创建副本 / 重命名 / 删除（空目录直接删，非空弹窗确认递归删）、
 * 文件行右键创建副本 / 重命名 / 删除（菜单内确认）。
 *
 * 交互：
 * - 单击 `.atlx` → 打开画布；单击 `.md` → 打开笔记编辑器；`.md`/附件拖到画布 → 建节点
 * - `.atlx` / `.md` 均可位于任意文件夹（无固定 画布/笔记/附件 目录）
 *
 * 分层：用 `vaultStore`（文件树/笔记 CRUD）+ `appStore`（画布 CRUD/切换）+ `canvasStore`（建节点），
 * 不直调 service。canvas 相关的定位动作走 props 回调。
 */
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  LayoutDashboard,
  Loader2,
  Palette,
  Paperclip,
  Pencil,
  RotateCcw,
  StickyNote,
  Table,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReactFlow } from "@xyflow/react";
import { useAppStore } from "@/stores/appStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { useVaultStore } from "@/stores/vaultStore";
import { FileContextMenu } from "@/components/canvas/panels/FileContextMenu";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Menu, MenuDivider, MenuItem } from "@/components/common/Menu";
import { baseName, noteTitleFromFile, stripExt, tableTitleFromFile } from "@/utils/filename";
import { foregroundFor } from "@/utils/color";
import type { CanvasFileRow, FileExplorerSortKey, FileTreeNode } from "@/types";

/** 拖拽负载 MIME，工作区 onDrop 据此识别面板拖来的文件。 */
export const ATELYX_FILE_MIME = "application/x-atelyx-vault-file";

/** 拖拽负载：标识来源文件类型 + 路径 + 显示名。 */
export interface AtelyxFilePayload {
  kind: "note" | "attachment";
  /** 相对仓库根路径，如 `项目A/foo.md`（任意文件夹） */
  file: string;
  /** 文件名（含扩展名） */
  name: string;
  /** note 的显示标题（文件名去 .md）；attachment 不填。 */
  title?: string;
}

interface PanelProps {
  /** 单击画布行：打开画布并激活画布窗口（页面层包装 openCanvas + setActiveWindow）。 */
  onOpenCanvasFile: (row: CanvasFileRow) => void;
  /** 单击 `.md`：在工作区主编辑区打开笔记编辑器。 */
  onOpenNoteForEdit: (file: string, title: string) => void;
  /** 单击 `.atb`：在工作区主编辑区打开表格编辑器。 */
  onOpenTableFile: (file: string, title: string) => void;
  /** 当前笔记窗口打开的文件（相对仓库根路径）；笔记区用它高亮当前打开的行（与画布区对称）。 */
  openedNoteFile: string | null;
  /** 当前表格窗口打开的文件（相对仓库根路径）；表格行高亮用（与笔记区对称）。 */
  openedTableFile: string | null;
  /** 右键 `.canvas` 行「转换为画布」：页面层执行转换并打开新画布。 */
  onConvertWhiteboard: (file: string) => void;
}

/** 排序方式（目录/文件均含 mtime，故只提供文件名/编辑时间两类；作用于树每层）。 */
const SORT_OPTIONS: { key: FileExplorerSortKey; label: string }[] = [
  { key: "name-asc", label: "文件名 (A-Z)" },
  { key: "name-desc", label: "文件名 (Z-A)" },
  { key: "mtime-desc", label: "编辑时间 (从新到旧)" },
  { key: "mtime-asc", label: "编辑时间 (从旧到新)" },
];

/** 默认排序（与仓库级配置缺省一致）。 */
const DEFAULT_SORT_KEY: FileExplorerSortKey = "mtime-desc";

/** 文件夹图标颜色预设色板（右键「图标颜色」选择；独立落盘 .atelyx/folder-colors.json）。 */
const FOLDER_COLOR_PRESETS = [
  "#e05252",
  "#e07b39",
  "#e0b436",
  "#4fae6a",
  "#2f9e8f",
  "#4f8fd0",
  "#7a6fd0",
  "#c05fa8",
];

/** 仓库级配置可能被外部手改，非法值回退默认。 */
function isSortKey(v: FileExplorerSortKey | undefined): v is FileExplorerSortKey {
  return SORT_OPTIONS.some((o) => o.key === v);
}

/** 大写文件扩展名（不含英文句号），无扩展名返回空串。 */
function upperExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toUpperCase() : "";
}

/** 行内编辑输入框（重命名 / 新建草稿共用）：Enter 提交、Esc 取消、失焦提交（挂载自动聚焦）。 */
function InlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      placeholder={placeholder}
      className="flex-1 bg-transparent border-b border-[var(--accent)] outline-none text-xs"
      style={{ color: "var(--text-primary)" }}
    />
  );
}

/** 名称切成「数字段 / 非数字段」交替序列（中文字符属非数字段）。 */
const NATURAL_BLOCKS = /\d+|\D+/g;

/** 数字段按数值比较（1000 进制：file2 < file10）；前导零多者排后（1 < 01）。 */
function compareNumeric(a: string, b: string): number {
  const ta = a.replace(/^0+/, "");
  const tb = b.replace(/^0+/, "");
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  if (ta === tb) return a.length - b.length;
  return ta < tb ? -1 : 1;
}

/** 自然排序：数字段按数值（1000 进制）、非数字段按中文本地化比较。 */
function compareNatural(a: string, b: string): number {
  const pa = a.match(NATURAL_BLOCKS) ?? [];
  const pb = b.match(NATURAL_BLOCKS) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const sa = pa[i];
    const sb = pb[i];
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const c = compareNumeric(sa, sb);
      if (c !== 0) return c;
    } else if (na !== nb) {
      return na ? -1 : 1; // 数字段排前（"章2" < "章A"）
    } else {
      const c = sa.localeCompare(sb, "zh");
      if (c !== 0) return c;
    }
  }
  return pa.length - pb.length;
}

/** 递归收集树中全部文件夹路径（「展开/收起全部」用）。 */
function collectDirPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.isDir) {
      out.push(n.path);
      out.push(...collectDirPaths(n.children));
    }
  }
  return out;
}

/** 右键菜单目标。 */
type MenuTarget =
  | { kind: "folder"; dir: string }
  | { kind: "canvas"; row: CanvasFileRow }
  | { kind: "note"; file: string; name: string }
  | { kind: "table"; file: string; name: string }
  | { kind: "attachment"; file: string; name: string };

/** inline 输入行（行内重命名 / 文件夹下新建）。 */
type Editing =
  | { kind: "canvas"; file: string; value: string }
  | { kind: "note"; file: string; value: string }
  | { kind: "table"; file: string; value: string }
  | { kind: "attachment"; file: string; value: string }
  | { kind: "folder"; dir: string; value: string }
  | { kind: "creating"; dir: string; type: "canvas" | "note" | "table" | "folder"; value: string };

export function FileExplorerPanel({ onOpenCanvasFile, onOpenNoteForEdit, onOpenTableFile, openedNoteFile, openedTableFile, onConvertWhiteboard }: PanelProps) {
  const tree = useVaultStore((s) => s.tree);
  const loadFiles = useVaultStore((s) => s.loadFiles);
  const createNote = useVaultStore((s) => s.createNote);
  const renameNote = useVaultStore((s) => s.renameNote);
  const deleteNote = useVaultStore((s) => s.deleteNote);
  const duplicateNote = useVaultStore((s) => s.duplicateNote);
  const renameAttachment = useVaultStore((s) => s.renameAttachment);
  const deleteAttachment = useVaultStore((s) => s.deleteAttachment);
  const duplicateAttachment = useVaultStore((s) => s.duplicateAttachment);
  const createFolder = useVaultStore((s) => s.createFolder);
  const deleteFolder = useVaultStore((s) => s.deleteFolder);
  const renameFolder = useVaultStore((s) => s.renameFolder);
  const duplicateFolder = useVaultStore((s) => s.duplicateFolder);
  const moveNote = useVaultStore((s) => s.moveNote);
  const moveAttachment = useVaultStore((s) => s.moveAttachment);
  const moveFolder = useVaultStore((s) => s.moveFolder);
  // 系统提示词标记（独立落盘 .atelyx/prompt-notes.json）：右键菜单显示注册/注销状态
  const promptFiles = useSettingsStore((s) => s.promptNotes);
  const togglePromptNote = useSettingsStore((s) => s.togglePromptNote);
  // 文件夹图标颜色（独立落盘 .atelyx/folder-colors.json）：右键色板设置/还原
  const folderColors = useSettingsStore((s) => s.folderColors);
  const setFolderColor = useSettingsStore((s) => s.setFolderColor);

  const canvases = useAppStore((s) => s.canvases);
  const currentCanvasFile = useAppStore((s) => s.currentCanvasFile);
  // 切换仓库读条：树已清空等待新仓库数据时显示加载占位（防残留旧仓库文件树）
  const switchingVault = useAppStore((s) => s.switchingVault);
  const createCanvas = useAppStore((s) => s.createCanvas);
  const renameCanvas = useAppStore((s) => s.renameCanvas);
  const deleteCanvas = useAppStore((s) => s.deleteCanvas);
  const moveCanvas = useAppStore((s) => s.moveCanvas);
  const duplicateCanvas = useAppStore((s) => s.duplicateCanvas);
  const createTable = useVaultStore((s) => s.createTable);
  const renameTable = useVaultStore((s) => s.renameTable);
  const deleteTable = useVaultStore((s) => s.deleteTable);
  const moveTable = useVaultStore((s) => s.moveTable);
  const duplicateTable = useVaultStore((s) => s.duplicateTable);

  // 展开集合（初始空 = 默认全部折叠：进入仓库只显示顶层文件夹；点文件夹展开）。
  // 展开状态仓库级持久化（uiStateStore → .atelyx/ui-state.json），进入仓库自动恢复上次展开情况
  const expanded = useUiStateStore((s) => s.fileExplorerExpanded);
  const toggleExpanded = useUiStateStore((s) => s.toggleExpanded);
  const toggleExpandAll = useUiStateStore((s) => s.toggleExpandAll);
  // 「展开/收起全部」：收集当前树全部文件夹路径；全部展开时按钮切换为收起
  const dirPaths = useMemo(() => collectDirPaths(tree), [tree]);
  const allExpanded = dirPaths.length > 0 && dirPaths.every((p) => expanded.has(p));
  // 排序方式下拉气泡（图标按钮触发）
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);

  // ===== pointer 模拟拖拽（HTML5 DnD 在 WebView2 不可靠，弃用）=====
  const { screenToFlowPosition } = useReactFlow();
  const addTextNoteFromVault = useCanvasStore((s) => s.addTextNoteFromVault);
  const addMediaFromVault = useCanvasStore((s) => s.addMediaFromVault);
  const addTableFromVault = useCanvasStore((s) => s.addTableFromVault);
  interface DragSession {
    kind: "note" | "attachment" | "canvas" | "table" | "folder";
    file: string;
    name: string;
    title?: string;
    startX: number;
    startY: number;
    active: boolean;
    x: number;
    y: number;
  }
  const dragRef = useRef<DragSession | null>(null);
  const [dragGhost, setDragGhost] = useState<{ kind: "note" | "attachment" | "canvas" | "table" | "folder"; label: string; x: number; y: number } | null>(null);
  /** 拖拽悬停的目标文件夹（data-dir 命中），高亮提示可放入；null = 无目标。 */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const dropDirRef = useRef<string | null>(null);
  /** 拖拽悬停可交互目标的提示文本（幽灵下方显示）；null = 无目标。 */
  const [dragHint, setDragHint] = useState<string | null>(null);
  const dragHintRef = useRef<string | null>(null);
  const expandDirs = useUiStateStore((s) => s.expandDirs);

  /** 拖拽松手在文件夹行上：移动文件/文件夹到该目录（画布/笔记/附件/文件夹按 kind 分派）。 */
  const handleMoveFile = useCallback(
    async (d: DragSession, dir: string) => {
      try {
        if (d.kind === "folder") {
          const newDir = await moveFolder(d.file, dir);
          const newName = baseName(newDir);
          if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
        } else if (d.kind === "canvas") {
          const row = canvases.find((c) => c.file === d.file);
          if (row) {
            const newFile = await moveCanvas(row, dir);
            const newName = baseName(newFile);
            if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
          } else {
            // 外部白板（.canvas）不在画布列表：走通用文件移动（对任意文件生效）
            const newFile = await moveAttachment(d.file, dir);
            const newName = baseName(newFile);
            if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
          }
        } else if (d.kind === "note") {
          const newFile = await moveNote(d.file, dir);
          const newName = baseName(newFile);
          if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
        } else if (d.kind === "table") {
          const newFile = await moveTable(d.file, dir);
          const newName = baseName(newFile);
          if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
        } else {
          const newFile = await moveAttachment(d.file, dir);
          const newName = baseName(newFile);
          if (newName !== d.name) setNotice(`「${d.name}」已存在，已重命名为「${newName}」`);
        }
        // 移动成功：展开目标文件夹及其祖先让文件可见
        const parts = dir.split("/").filter(Boolean);
        let acc = "";
        const dirs: string[] = [];
        for (const p of parts) {
          acc = acc ? `${acc}/${p}` : p;
          dirs.push(acc);
        }
        expandDirs(dirs);
      } catch (err) {
        console.error("移动文件失败", err);
        setNotice("移动文件失败，请重试");
      }
    },
    [canvases, moveFolder, moveCanvas, moveNote, moveTable, moveAttachment, expandDirs],
  );

  // 全局 pointermove/up：位移超 5px 进入拖拽（显示幽灵）；松手在文件夹行 = 移动文件，落点在 .react-flow 内 = 建节点
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (d.active || dist > 5) {
        // 位置变化超 2px 才 setState（pointermove 高频触发，节流避免每帧重渲染整个面板）
        const moved = !d.active || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 2;
        dragRef.current = { ...d, active: true, x: e.clientX, y: e.clientY };
        if (moved) setDragGhost({ kind: d.kind, label: d.title ?? d.name, x: e.clientX, y: e.clientY });
        // 拖拽悬停目标文件夹：高亮可放入（变化才 setState）；文件行（data-file）内部不视为目标（防误判根目录）
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const dirEl = hit?.closest<HTMLElement>("[data-dir]");
        let dir = dirEl && !hit?.closest<HTMLElement>("[data-file]") ? (dirEl.dataset.dir ?? "") : null;
        // 拖文件夹：自身、自身后代、自身祖先均不可放入（非法嵌套/原地 no-op），不高亮
        if (
          d.kind === "folder" &&
          dir !== null &&
          (dir === d.file || dir.startsWith(`${d.file}/`) || d.file.startsWith(`${dir}/`))
        ) {
          dir = null;
        }
        if (dir !== dropDirRef.current) {
          dropDirRef.current = dir;
          setDropDir(dir);
        }
        // 悬停可交互目标的提示文本（幽灵下方显示；变化才 setState）：分支顺序与 onUp 落点判定严格一致
        let hint: string | null = null;
        if (hit?.closest<HTMLElement>("[data-chat-input]")) {
          if (d.kind === "note") hint = "作为引用";
        } else if (dir !== null) {
          hint = dir === "" ? "移到根目录" : `移动到「${baseName(dir)}」`;
        } else if (hit?.closest(".react-flow")) {
          if (d.kind === "note") hint = "创建文本节点";
          else if (d.kind === "table") hint = "创建表格节点";
          else if (d.kind === "attachment") hint = "创建媒体节点";
        }
        if (hint !== dragHintRef.current) {
          dragHintRef.current = hint;
          setDragHint(hint);
        }
        // 平时行上不显示 grab 光标（避免误以为可点），拖拽激活时才显示「抓住」
        document.body.style.cursor = "grabbing";
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragGhost(null);
      dropDirRef.current = null;
      setDropDir(null);
      dragHintRef.current = null;
      setDragHint(null);
      document.body.style.cursor = "";
      if (!d?.active) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      // 拖入右侧 AI 对话面板输入框（data-chat-input）：笔记 → @引用 入队（AiChatPanel 消费后显示 @标签）
      if (target?.closest<HTMLElement>("[data-chat-input]")) {
        if (d.kind === "note") {
          useChatPanelStore
            .getState()
            .queueMention({ file: d.file, label: d.title ?? d.name.replace(/\.md$/i, "") });
        }
        return;
      }
      // 优先：落到文件夹行/树空白（data-dir，含根目录 data-dir=""）→ 移动文件；文件行内部不是目标
      const dirEl = target?.closest<HTMLElement>("[data-dir]");
      const inFileRow = !!target?.closest<HTMLElement>("[data-file]");
      if (dirEl && !inFileRow) {
        void handleMoveFile(d, dirEl.dataset.dir ?? "");
        return;
      }
      if (target?.closest(".react-flow")) {
        // 画布行（kind="canvas"）与文件夹行只支持拖到文件夹移动，不支持拖到画布建节点（media 节点会按附件误读 JSON）
        if (d.kind === "canvas" || d.kind === "folder") return;
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (d.kind === "note") void addTextNoteFromVault(d.file, d.title ?? d.name, pos, true);
        else if (d.kind === "table") void addTableFromVault(d.file, d.title ?? d.name, pos, true);
        else void addMediaFromVault(d.file, d.name, pos, true);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [screenToFlowPosition, addTextNoteFromVault, addMediaFromVault, addTableFromVault, handleMoveFile]);

  /** 行按下（左键）记录潜在拖拽会话（文件夹/画布/笔记/附件均可拖：移动到文件夹；文件还可拖到画布建节点）；位移超阈值才真正拖拽。 */
  const startPotentialDrag = (e: React.PointerEvent, node: FileTreeNode) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 阻止文本选择干扰
    if (node.isDir) {
      dragRef.current = {
        kind: "folder",
        file: node.path,
        name: node.name,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        x: e.clientX,
        y: e.clientY,
      };
      return;
    }
    // 外部白板（.canvas）与 .atlx 同归 canvas 类：拖到画布不建节点（只支持移动到文件夹）
    const lower = node.name.toLowerCase();
    const isCanvasFile = lower.endsWith(".atlx") || lower.endsWith(".canvas");
    const kind = isCanvasFile
      ? "canvas"
      : lower.endsWith(".md")
        ? "note"
        : lower.endsWith(".atb")
          ? "table"
          : "attachment";
    dragRef.current = {
      kind,
      file: node.path,
      name: node.name,
      title: kind === "note" ? noteTitleFromFile(node.path) : kind === "table" ? tableTitleFromFile(node.path) : undefined,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      x: e.clientX,
      y: e.clientY,
    };
  };

  // 重名自动加序号的提醒（3s 后自动消失）
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // 非空文件夹删除确认弹窗（空文件夹直接删，无确认）
  const [confirmDelete, setConfirmDelete] = useState<{ dir: string; name: string; count: number } | null>(null);
  /** 删除文件夹：先试非递归（空目录直接删）；非空返回 needsConfirm → 弹窗确认后递归删。 */
  const handleDeleteFolder = useCallback(async (dir: string) => {
    try {
      const res = await deleteFolder(dir);
      if (res.needsConfirm) {
        setConfirmDelete({ dir, name: baseName(dir), count: res.itemCount });
      }
    } catch (err) {
      console.error("删除文件夹失败", err);
      setNotice("删除文件夹失败，请重试");
    }
  }, [deleteFolder]);

  /** 复制文件/文件夹为同目录副本（同名自动加序号），按 kind 分派到 store。 */
  const duplicateAction = useCallback(
    async (t: MenuTarget) => {
      try {
        if (t.kind === "folder") {
          const newDir = await duplicateFolder(t.dir);
          setNotice(`已创建副本「${baseName(newDir)}」`);
        } else if (t.kind === "canvas") {
          const title = await duplicateCanvas(t.row);
          setNotice(`已创建副本「${title}」`);
        } else if (t.kind === "note") {
          const newFile = await duplicateNote(t.file);
          setNotice(`已创建副本「${baseName(newFile)}」`);
        } else if (t.kind === "table") {
          const newFile = await duplicateTable(t.file);
          setNotice(`已创建副本「${baseName(newFile)}」`);
        } else {
          const newFile = await duplicateAttachment(t.file);
          setNotice(`已创建副本「${baseName(newFile)}」`);
        }
      } catch (err) {
        console.error("复制失败", err);
        setNotice("复制失败，请重试");
      }
    },
    [duplicateFolder, duplicateCanvas, duplicateNote, duplicateTable, duplicateAttachment],
  );

  // 排序方式存仓库级配置（.atelyx/config.json），跨会话/跨仓库各自独立
  const vaultSort = useSettingsStore((s) => s.vaultConfig?.fileExplorerSort);
  const setFileExplorerSort = useSettingsStore((s) => s.setFileExplorerSort);
  const sortKey = isSortKey(vaultSort) ? vaultSort : DEFAULT_SORT_KEY;

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // 右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  // 文件夹颜色色板弹层（图标颜色 popup：文件夹路径 + 触发坐标）
  const [colorMenu, setColorMenu] = useState<{ x: number; y: number; dir: string } | null>(null);
  // inline 输入（行内重命名 / 新建草稿）
  const [editing, setEditing] = useState<Editing | null>(null);

  /** 提交 inline 输入（新建/重命名），返回是否继续保留编辑态。 */
  const commitEditing = async (e: Editing) => {
    const v = e.value.trim();
    setEditing(null);
    if (!v) return;
    try {
      if (e.kind === "canvas") {
        const actual = await renameCanvas(
          canvases.find((c) => c.file === e.file)!,
          v,
        );
        if (actual !== v) setNotice(`「${v}」已存在，已重命名为「${actual}」`);
      } else if (e.kind === "note") {
        const newFile = await renameNote(e.file, v);
        const actualTitle = noteTitleFromFile(newFile);
        if (actualTitle !== v) setNotice(`「${v}」已存在，已重命名为「${actualTitle}」`);
      } else if (e.kind === "table") {
        const newFile = await renameTable(e.file, v);
        const actualTitle = tableTitleFromFile(newFile);
        if (actualTitle !== v) setNotice(`「${v}」已存在，已重命名为「${actualTitle}」`);
      } else if (e.kind === "attachment") {
        await renameAttachment(e.file, v);
      } else if (e.kind === "folder") {
        const actualDir = await renameFolder(e.dir, v);
        const actualName = baseName(actualDir);
        if (actualName !== v) setNotice(`「${v}」已存在，已重命名为「${actualName}」`);
      } else if (e.kind === "creating") {
        if (e.type === "canvas") {
          const { id, file, title } = await createCanvas(v, e.dir);
          if (file && id) {
            onOpenCanvasFile({ id, file, title, updatedAt: 0 });
          }
          if (title !== v) setNotice(`「${v}」已存在，已创建为「${title}」`);
        } else if (e.type === "note") {
          const file = await createNote(v, e.dir);
          const actualTitle = noteTitleFromFile(file);
          if (actualTitle !== v) setNotice(`「${v}」已存在，已创建为「${actualTitle}」`);
        } else if (e.type === "table") {
          const { file, title } = await createTable(v, e.dir);
          if (title !== v) setNotice(`「${v}」已存在，已创建为「${title}」`);
          if (file) onOpenTableFile(file, title);
        } else {
          const dirPath = e.dir ? `${e.dir}/${v}` : v;
          await createFolder(dirPath);
        }
      }
    } catch (err) {
      console.error("操作失败", err);
      setNotice("操作失败，请重试");
    }
  };

  /** 画布行：从 canvases 列表按 file 找（扫描失败/损坏 .atlx 不在列表，无 row 不提供画布操作）。 */
  const canvasRowOf = (path: string): CanvasFileRow | undefined =>
    canvases.find((c) => c.file === path);

  /** 每层排序：文件夹固定按名称 A-Z（自然排序），文件按 sortKey（名称排序也用自然排序）。 */
  const sortChildren = (children: FileTreeNode[]): FileTreeNode[] => {
    const dirs = children.filter((c) => c.isDir);
    const files = children.filter((c) => !c.isDir);
    const byName = (asc: boolean) => (a: FileTreeNode, b: FileTreeNode) =>
      asc ? compareNatural(a.name, b.name) : compareNatural(b.name, a.name);
    const byMtime = (asc: boolean) => (a: FileTreeNode, b: FileTreeNode) =>
      asc ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
    const dirCmp = (a: FileTreeNode, b: FileTreeNode) => compareNatural(a.name, b.name);
    const fileCmp = sortKey.startsWith("name") ? byName(sortKey.endsWith("asc")) : byMtime(sortKey.endsWith("asc"));
    return [...dirs.sort(dirCmp), ...files.sort(fileCmp)];
  };

  const renderTree = (nodes: FileTreeNode[], depth: number, parentDir: string): ReactNode => {
    // 新建草稿输入行：渲染在目标文件夹 children 顶部（根目录 = 树顶部）
    const creatingHere =
      editing?.kind === "creating" && editing.dir === parentDir ? (
        <li key="__creating__" className="px-2 pl-6 py-1 flex items-center gap-1">
          <InlineInput
            value={editing.value}
            onChange={(v) => setEditing({ ...editing, value: v })}
            onCommit={() => void commitEditing(editing)}
            onCancel={() => setEditing(null)}
            placeholder={
              editing.type === "canvas"
                ? "画布名称"
                : editing.type === "note"
                  ? "笔记名称"
                  : editing.type === "table"
                    ? "表格名称"
                    : "文件夹名称"
            }
          />
        </li>
      ) : null;

    return (
      <>
        {creatingHere}
        {nodes.map((node) => {
          const indent = { paddingLeft: 6 + depth * 12 };
          if (node.isDir) {
            const isExpanded = expanded.has(node.path);
            const editingThis: Editing | null =
              editing?.kind === "folder" && editing.dir === node.path ? editing : null;
            return (
              <li key={node.path}>
                {editingThis ? (
                  <div className="flex items-center px-2 py-1 min-h-8" style={indent}>
                    <InlineInput
                      value={editingThis.value}
                      onChange={(v) => setEditing({ ...editingThis, value: v })}
                      onCommit={() => void commitEditing(editingThis)}
                      onCancel={() => setEditing(null)}
                      placeholder="文件夹名称"
                    />
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-1 px-2 py-1 min-h-8 select-none cursor-default rounded-md hover:bg-[var(--hover)]"
                    style={{
                      ...indent,
                      // 拖拽悬停目标高亮（金色底），提示可放入移动
                      background: dropDir === node.path ? "color-mix(in srgb, var(--accent) 25%, transparent)" : undefined,
                    }}
                    data-dir={node.path}
                    onPointerDown={(e) => startPotentialDrag(e, node)}
                    onClick={() => toggleExpanded(node.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "folder", dir: node.path } });
                    }}
                  >
                    <span className="flex items-center">{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                    <Folder size={14} style={{ color: folderColors?.[node.path] ?? "var(--text-muted)" }} />
                    <span className="flex-1 truncate text-xs" style={{ color: "var(--text-primary)" }}>{node.name}</span>
                  </div>
                )}
                {isExpanded && (
                  <ul className="relative">
                    {/* 展开指示线：从父行图标中心垂下，贯穿全部子项（pointer-events-none 防拦截拖拽落点判定） */}
                    <div
                      className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
                      style={{
                        // 行 padding-left（inline 覆盖 px-2）= 6 + depth*12，加 chevron 半宽 7
                        left: 13 + depth * 12,
                        background: "var(--text-muted)",
                        opacity: 0.6,
                      }}
                    />
                    {renderTree(sortChildren(node.children), depth + 1, node.path)}
                  </ul>
                )}
              </li>
            );
          }
          // 文件行
          const isCanvas = node.name.toLowerCase().endsWith(".atlx");
          const isWhiteboard = node.name.toLowerCase().endsWith(".canvas");
          const isNote = node.name.toLowerCase().endsWith(".md");
          const isTable = node.name.toLowerCase().endsWith(".atb");
          const row = isCanvas ? canvasRowOf(node.path) : undefined;
          const active =
            (isCanvas && row && currentCanvasFile === row.file) ||
            (isWhiteboard && currentCanvasFile === node.path) ||
            (isNote && openedNoteFile === node.path) ||
            (isTable && openedTableFile === node.path);
          const editingThis: Editing | null =
            editing?.kind === "canvas" && editing.file === node.path
              ? editing
              : editing?.kind === "note" && editing.file === node.path
                ? editing
                : editing?.kind === "table" && editing.file === node.path
                  ? editing
                  : editing?.kind === "attachment" && editing.file === node.path
                    ? editing
                    : null;
          return (
            <li key={node.path}>
              {editingThis ? (
                <div className="flex items-center px-2 py-1 min-h-8" style={indent}>
                  <InlineInput
                    value={editingThis.value}
                    onChange={(v) => setEditing({ ...editingThis, value: v })}
                    onCommit={() => void commitEditing(editingThis)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <div
                  className="flex items-center gap-1 px-2 py-1 min-h-8 cursor-default rounded-md hover:bg-[var(--hover)]"
                  style={{
                    ...indent,
                    background: active ? "color-mix(in srgb, var(--accent) 20%, transparent)" : undefined,
                  }}
                  data-file={node.path}
                  onPointerDown={(e) => startPotentialDrag(e, node)}
                  onClick={() => {
                    if (isCanvas && row) onOpenCanvasFile(row);
                    else if (isWhiteboard) {
                      // 外部白板：合成行打开（id = 路径 = 运行时身份，只读查看）
                      onOpenCanvasFile({
                        id: node.path,
                        title: stripExt(node.name),
                        file: node.path,
                        updatedAt: node.updatedAt,
                      });
                    } else if (isNote) onOpenNoteForEdit(node.path, noteTitleFromFile(node.path));
                    else if (isTable) onOpenTableFile(node.path, tableTitleFromFile(node.path));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isCanvas && row) {
                      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "canvas", row } });
                    } else if (isNote) {
                      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "note", file: node.path, name: node.name } });
                    } else if (isTable) {
                      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "table", file: node.path, name: node.name } });
                    } else {
                      setMenu({ x: e.clientX, y: e.clientY, target: { kind: "attachment", file: node.path, name: node.name } });
                    }
                  }}
                >
                  {isCanvas ? (
                    <FileText size={14} style={{ color: "var(--text-muted)" }} />
                  ) : isWhiteboard ? (
                    <LayoutDashboard size={14} style={{ color: "var(--text-muted)" }} />
                  ) : isNote ? (
                    <StickyNote size={14} style={{ color: "var(--text-muted)" }} />
                  ) : isTable ? (
                    <Table size={14} style={{ color: "var(--text-muted)" }} />
                  ) : (
                    <Paperclip size={14} style={{ color: "var(--text-muted)" }} />
                  )}
                  <span className="flex-1 truncate text-xs" style={{ color: "var(--text-primary)" }}>{node.name}</span>
                  <span
                    className="ml-auto pl-2 text-[10px] font-bold flex-shrink-0"
                    style={{ color: "var(--text-muted)", opacity: 0.6 }}
                  >
                    {isCanvas ? "ATLX" : isWhiteboard ? "CANVAS" : isNote ? "MD" : isTable ? "ATB" : upperExt(node.name)}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </>
    );
  };

  return (
    <div
      className="h-full flex flex-col text-sm overflow-hidden"
      style={{ background: "var(--bg-secondary)", color: "var(--text-primary)" }}
    >
      {/* 工具条：排序方式下拉气泡 + 展开/收起全部（图标按钮，切换） */}
      <div className="px-2 py-1.5 border-b flex items-center gap-1" style={{ borderColor: "var(--border)" }}>
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSortMenu({ x: rect.right, y: rect.bottom });
          }}
          className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)" }}
          title="排序方式"
        >
          <ArrowUpDown size={14} />
        </button>
        <button
          onClick={() => {
            if (dirPaths.length === 0) return;
            toggleExpandAll(dirPaths);
          }}
          className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)" }}
          title={allExpanded ? "收起全部文件夹" : "展开全部文件夹"}
        >
          {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
        </button>
        {sortMenu && (
          <SortMenu
            x={sortMenu.x}
            y={sortMenu.y}
            value={sortKey}
            onChange={(k) => {
              void setFileExplorerSort(k);
              setSortMenu(null);
            }}
            onClose={() => setSortMenu(null)}
          />
        )}
      </div>

      {/* 重名自动加序号提醒 */}
      {notice && (
        <div
          className="px-3 py-1 text-xs border-b"
          style={{ color: "#f59e0b", borderColor: "var(--border)" }}
        >
          {notice}
        </div>
      )}

      {/* 文件树空白处右键 = 在仓库根目录新建（画布/笔记/文件夹，inline 输入，Enter 创建） */}
      {/* 树容器（左右留白 px-2：条目不顶格，两侧空白 = 拖拽移根落点） */}
      <div
        className="flex-1 overflow-auto py-1 px-2"
        data-dir=""
        style={{ background: dropDir === "" ? "color-mix(in srgb, var(--accent) 25%, transparent)" : undefined }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, target: { kind: "folder", dir: "" } });
        }}
      >
        {/* 切换仓库中：树已被清空（旧仓库内容不残留），显示加载占位直到新仓库数据就绪 */}
        {switchingVault ? (
          <div
            className="flex items-center gap-1.5 px-3 py-2 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Loader2 size={12} className="animate-spin flex-shrink-0" />
            正在加载仓库…
          </div>
        ) : (
          <ul>{renderTree(sortChildren(tree), 0, "")}</ul>
        )}
      </div>

      {/* 拖拽幽灵（pointer 模拟拖拽时跟随鼠标；下方追加悬停目标的动作提示） */}
      {dragGhost && (
        <div
          className="fixed z-[9999] pointer-events-none px-2 py-1 rounded shadow-lg"
          style={{
            left: dragGhost.x + 10,
            top: dragGhost.y + 10,
            background: "var(--bg-tertiary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
          }}
        >
          <div className="text-xs">{dragGhost.label}</div>
          {dragHint && (
            <div className="mt-0.5 text-[10px] whitespace-nowrap" style={{ color: "var(--accent)" }}>
              {dragHint}
            </div>
          )}
        </div>
      )}

      {/* 文件夹右键菜单：新建画布 / 新建笔记 / 新建文件夹 + 重命名 / 删除（根目录仅新建） */}
      {(() => {
        const folderTarget = menu?.target.kind === "folder" ? menu.target : null;
        if (!folderTarget) return null;
        return (
          <FolderCreateMenu
            x={menu!.x}
            y={menu!.y}
            canManage={folderTarget.dir !== ""}
            currentColor={folderColors?.[folderTarget.dir]}
            onCreate={(type) => {
              setEditing({ kind: "creating", dir: folderTarget.dir, type, value: "" });
              setMenu(null);
            }}
            onColor={() => {
              const { x, y } = menu!;
              setMenu(null);
              setColorMenu({ x, y, dir: folderTarget.dir });
            }}
            onRename={() => {
              setEditing({
                kind: "folder",
                dir: folderTarget.dir,
                value: baseName(folderTarget.dir),
              });
              setMenu(null);
            }}
            onDuplicate={() => {
              setMenu(null);
              void duplicateAction({ kind: "folder", dir: folderTarget.dir });
            }}
            onDelete={() => {
              setMenu(null);
              void handleDeleteFolder(folderTarget.dir);
            }}
            onClose={() => setMenu(null)}
          />
        );
      })()}

      {/* 文件夹图标颜色色板（右键「图标颜色」打开；预设/自定义/默认，选后即时应用） */}
      {colorMenu && (
        <FolderColorMenu
          x={colorMenu.x}
          y={colorMenu.y}
          currentColor={folderColors?.[colorMenu.dir]}
          onChange={(c) => {
            void setFolderColor(colorMenu.dir, c);
          }}
          onClose={() => setColorMenu(null)}
        />
      )}

      {/* 文件行右键菜单：重命名 / 删除（菜单内确认） */}
      {menu && menu.target.kind !== "folder" && (() => {
        const t = menu.target;
        return (
          <FileContextMenu
            x={menu.x}
            y={menu.y}
            onRename={() => {
              if (t.kind === "canvas") setEditing({ kind: "canvas", file: t.row.file, value: t.row.title });
              else if (t.kind === "note") setEditing({ kind: "note", file: t.file, value: noteTitleFromFile(t.file) });
              else if (t.kind === "table") setEditing({ kind: "table", file: t.file, value: tableTitleFromFile(t.file) });
              else if (t.kind === "attachment") setEditing({ kind: "attachment", file: t.file, value: t.name });
              setMenu(null);
            }}
            onDuplicate={() => {
              setMenu(null);
              void duplicateAction(t);
            }}
            onDelete={() => {
              if (t.kind === "canvas") void deleteCanvas(t.row).catch(() => setNotice("删除画布失败，请重试"));
              else if (t.kind === "note") void deleteNote(t.file).catch(() => setNotice("删除笔记失败，请重试"));
              else if (t.kind === "table") void deleteTable(t.file).catch(() => setNotice("删除表格失败，请重试"));
              else if (t.kind === "attachment") void deleteAttachment(t.file).catch(() => setNotice("删除附件失败，请重试"));
              setMenu(null);
            }}
            onTogglePrompt={t.kind === "note" ? () => void togglePromptNote(t.file) : undefined}
            promptMarked={t.kind === "note" ? promptFiles.includes(t.file) : undefined}
            onConvert={
              t.kind === "attachment" && t.name.toLowerCase().endsWith(".canvas")
                ? () => onConvertWhiteboard(t.file)
                : undefined
            }
            onClose={() => setMenu(null)}
          />
        );
      })()}

      {/* 非空文件夹删除确认弹窗（确认后递归删除） */}
      {confirmDelete && (
        <ConfirmDialog
          title={`删除文件夹「${confirmDelete.name}」？`}
          description={`文件夹包含 ${confirmDelete.count} 个文件/文件夹，删除后不可恢复。`}
          confirmText="删除"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const { dir } = confirmDelete;
            setConfirmDelete(null);
            void deleteFolder(dir, true).catch(() => setNotice("删除文件夹失败，请重试"));
          }}
        />
      )}
    </div>
  );
}

/** 文件夹右键菜单：新建画布 / 新建笔记 / 新建表格 / 新建文件夹 + 图标颜色 + 创建副本 + 重命名 / 删除（根目录仅新建）。 */
function FolderCreateMenu({
  x,
  y,
  canManage,
  currentColor,
  onCreate,
  onColor,
  onDuplicate,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  /** 非根目录才有创建副本/重命名/删除；树空白处右键 = 根目录，仅新建。 */
  canManage: boolean;
  /** 当前文件夹图标颜色（hex；未设置 = undefined）。 */
  currentColor?: string;
  onCreate: (type: "canvas" | "note" | "table" | "folder") => void;
  onColor: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Menu x={x} y={y} onClose={onClose} widthClass="w-44" stopPointerDown>
      <MenuItem onClick={() => onCreate("canvas")}>
        <FileText size={14} /> 新建画布
      </MenuItem>
      <MenuItem onClick={() => onCreate("note")}>
        <StickyNote size={14} /> 新建笔记
      </MenuItem>
      <MenuItem onClick={() => onCreate("table")}>
        <Table size={14} /> 新建表格
      </MenuItem>
      <MenuItem onClick={() => onCreate("folder")}>
        <FolderPlus size={14} /> 新建文件夹
      </MenuItem>
      {canManage && (
        <>
          <MenuDivider />
          <MenuItem onClick={onColor} title="设置该文件夹的图标颜色（仓库级持久化）">
            <Palette size={14} />
            <span className="flex-1">图标颜色</span>
            {currentColor && (
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: currentColor }} />
            )}
          </MenuItem>
        </>
      )}
      {canManage && (
        <>
          <MenuDivider />
          <MenuItem onClick={onDuplicate}>
            <Copy size={14} /> 创建副本
          </MenuItem>
          <MenuDivider />
          <MenuItem onClick={onRename}>
            <Pencil size={14} /> 重命名
          </MenuItem>
          <MenuItem onClick={onDelete} danger>
            <Trash2 size={14} /> 删除
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** 文件夹图标颜色色板：预设色块 + 自定义取色 + 默认（清除）。预设/默认点击即应用并关闭；
 * 自定义取色器持续调节（原生颜色框 onChange 高频触发，仅应用不关闭，避免选取被中断）。 */
function FolderColorMenu({
  x,
  y,
  currentColor,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  currentColor?: string;
  /** 应用颜色（undefined = 清除还原默认）；不负责关闭，由本组件选择时机调 onClose。 */
  onChange: (color: string | undefined) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState(currentColor ?? "#4f8fd0");
  const pick = (c: string | undefined) => {
    onChange(c);
    onClose();
  };
  return (
    <Menu
      x={x}
      y={y}
      onClose={onClose}
      widthClass="w-44"
      repositionDeps={[custom, currentColor]}
      stopPointerDown
    >
      <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1.5">
        {FOLDER_COLOR_PRESETS.map((c) => {
          const active = c.toLowerCase() === currentColor?.toLowerCase();
          return (
            <button
              key={c}
              onClick={() => pick(c)}
              title={c}
              className="w-5 h-5 rounded-full flex items-center justify-center transition hover:scale-110 flex-shrink-0"
              style={{ background: c }}
            >
              {active && <Check size={11} style={{ color: foregroundFor(c) }} />}
            </button>
          );
        })}
      </div>
      <div className="px-3 py-1 flex items-center gap-1.5">
        <input
          type="color"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            onChange(e.target.value);
          }}
          title="自定义颜色"
          className="w-5 h-5 rounded cursor-pointer bg-transparent p-0 border-0 flex-shrink-0"
        />
        <span className="text-[10px] truncate" style={{ color: "var(--text-muted)" }}>
          自定义
        </span>
      </div>
      <MenuDivider />
      <MenuItem onClick={() => pick(undefined)} title="清除该文件夹图标颜色，还原默认">
        <span className="inline-flex items-center gap-1.5">
          <RotateCcw size={14} />
          默认
        </span>
      </MenuItem>
    </Menu>
  );
}

/** 排序方式下拉气泡（图标按钮触发；点击外部/Esc 关闭，当前项打勾）。 */
function SortMenu({
  x,
  y,
  value,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  value: FileExplorerSortKey;
  onChange: (key: FileExplorerSortKey) => void;
  onClose: () => void;
}) {
  return (
    <Menu x={x} y={y} onClose={onClose} widthClass="w-44" stopPointerDown>
      {SORT_OPTIONS.map((o) => (
        <MenuItem key={o.key} onClick={() => onChange(o.key)}>
          <span className="flex-1">{o.label}</span>
          {value === o.key && <Check size={12} style={{ color: "var(--accent)" }} />}
        </MenuItem>
      ))}
    </Menu>
  );
}
