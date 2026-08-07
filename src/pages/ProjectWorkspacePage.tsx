import { FileOutput, FilePlus, FileText, Grid3x3, LayoutDashboard, LayoutTemplate, Link2, Magnet, Maximize, MessageSquarePlus, Minus, Palette, PanelRightClose, PanelRightOpen, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import {
  ReactFlow,
  Background,
  ConnectionMode,
  ControlButton,
  MiniMap,
  Panel as FlowPanel,
  useReactFlow,
  useViewport,
  type Connection,
  type Viewport,
} from "@xyflow/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore, lastNoteRenameTarget } from "@/stores/vaultStore";
import { dedupeFilename } from "@/utils/filename";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { DEFAULT_CONVERSATION_WIDTH, DEFAULT_CONVERSATION_HEIGHT, DEFAULT_TEXT_NODE_WIDTH, DEFAULT_TEXT_NODE_HEIGHT, DEFAULT_GROUP_WIDTH, DEFAULT_GROUP_HEIGHT, DEFAULT_LINK_WIDTH, DEFAULT_LINK_HEIGHT } from "@/constants/canvas";
import { useCanvasHotkeys } from "@/hooks/useCanvasHotkeys";
import { ConversationNode } from "@/components/canvas/nodes/ConversationNode";
import { TextNode } from "@/components/canvas/nodes/TextNode";
import { MediaNode } from "@/components/canvas/nodes/MediaNode";
import { SearchResultNode } from "@/components/canvas/nodes/SearchResultNode";
import { GroupNode } from "@/components/canvas/nodes/GroupNode";
import { LinkNode } from "@/components/canvas/nodes/LinkNode";
import { NodeContextMenu } from "@/components/canvas/panels/NodeContextMenu";
import { ActivityBar } from "@/components/canvas/panels/ActivityBar";
import { InspectorPanel } from "@/components/canvas/panels/InspectorPanel";
import { AiChatPanel } from "@/components/canvas/panels/AiChatPanel";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import {
  FileExplorerPanel,
  ATELYX_FILE_MIME,
  type AtelyxFilePayload,
} from "@/components/canvas/panels/FileExplorerPanel";
import { SearchPanel } from "@/components/canvas/panels/SearchPanel";
import { DataFlowEdge } from "@/components/canvas/edges/DataFlowEdge";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { TitleBarControls } from "@/components/common/TitleBarControls";
import type { CanvasFileRow, FileTreeNode } from "@/types";

const nodeTypes = { conversation: ConversationNode, text: TextNode, media: MediaNode, search: SearchResultNode, group: GroupNode, link: LinkNode };
const edgeTypes = { default: DataFlowEdge };

// 连线合法性（边类型自动分类，见 2.4）：
// - 资产（text/media/search）→ 对话：数据流引用边，放行（重复由 onConnect「再次注入」处理）
// - 对话 → 资产：数据流产出边，同对已有边拦截（防重复）
// - 其余（对话↔对话、link/group 参与、无对话组合）：关联自由线，同对已有边拦截
const isValidConnection = (connection: Edge | Connection) => {
  if (connection.source === connection.target) return false;
  const state = useCanvasStore.getState();
  const nodes = state.nodes;
  const src = nodes.find((n) => n.id === connection.source);
  const tgt = nodes.find((n) => n.id === connection.target);
  if (!src || !tgt) return false;
  const isAsset = (t: string | undefined) =>
    t === "text" || t === "media" || t === "search";
  const isAssetToConv = isAsset(src.type) && tgt.type === "conversation";
  // 同对已有任意边（数据流产出/关联）→ 拦截；资产→对话例外（onConnect 处理「再次注入」）
  if (!isAssetToConv) {
    const already = state.edges.some(
      (e) => e.source === connection.source && e.target === connection.target
    );
    if (already) return false;
  }
  return true;
};

export function ProjectWorkspacePage({
  canvasId,
  canvasFile,
}: {
  canvasId: string | null;
  /** 当前画布磁盘路径（相对仓库根，按路径加载/保存）。 */
  canvasFile: string | null;
}) {
  // 逐字段 selector：流式只更新 messagesByConv，避免整页每帧重渲染
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const readOnly = useCanvasStore((s) => s.readOnly);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const load = useCanvasStore((s) => s.load);
  const loading = useCanvasStore((s) => s.loading);
  const saving = useCanvasStore((s) => s.saving);
  const canvasError = useCanvasStore((s) => s.error);
  const clearError = useCanvasStore((s) => s.clearError);
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const renameCanvas = useCanvasStore((s) => s.renameCanvas);
  const onNodeDragStart = useCanvasStore((s) => s.onNodeDragStart);
  const onNodeDragStop = useCanvasStore((s) => s.onNodeDragStop);
  const conflictPending = useCanvasStore((s) => s.conflictPending);
  const reloadFromDisk = useCanvasStore((s) => s.reloadFromDisk);
  const mergeFromDisk = useCanvasStore((s) => s.mergeFromDisk);
  const openCanvas = useAppStore((s) => s.openCanvas);
  const closeCanvasFile = useAppStore((s) => s.closeCanvasFile);
  const convertWhiteboard = useAppStore((s) => s.convertWhiteboard);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, setCenter } = useReactFlow();

  const [showSettings, setShowSettings] = useState(false);
  // 左栏面板视图：文件面板 / 搜索面板（null = 收起；ActivityBar 图标切换，不持久化）
  const [leftPanel, setLeftPanel] = useState<"files" | "search" | null>("files");
  const [showInspector, setShowInspector] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  // 网格吸附开关（左下角按钮组磁铁按钮切换，默认开）
  const [snapEnabled, setSnapEnabled] = useState(true);
  // 右侧边栏 tab：节点属性 / AI 对话（打开笔记自动切 AI 对话，见联动 effect，）
  const [inspectorTab, setInspectorTab] = useState<"properties" | "ai">("properties");
  // 主体 PanelGroup 列宽百分比（onLayout 回调），标签区对齐编辑区左缘需要左列像素宽
  const [colPct, setColPct] = useState<number[]>([]);
  // 属性面板：单击节点选中显示属性（null = 未选中，画布空白处点击清空）
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null);
  // 无画布时的笔记编辑器（单击文件面板笔记打开，）
  const [editingNote, setEditingNote] = useState<{ file: string; title: string } | null>(null);

  const vaultNoteList = useVaultStore((s) => s.noteList);
  // 仓库级 UI 使用状态：上次打开的画布/笔记 + 激活窗口，进仓库自动恢复
  const uiLoaded = useUiStateStore((s) => s.loaded);
  const lastCanvasFile = useUiStateStore((s) => s.lastCanvasFile);
  const lastNoteFile = useUiStateStore((s) => s.lastNoteFile);
  const lastActiveWindow = useUiStateStore((s) => s.lastActiveWindow);
  const recordOpenCanvas = useUiStateStore((s) => s.recordOpenCanvas);
  const recordOpenNote = useUiStateStore((s) => s.recordOpenNote);
  const recordActiveWindow = useUiStateStore((s) => s.recordActiveWindow);
  const closeUiCanvas = useUiStateStore((s) => s.closeCanvas);
  const closeUiNote = useUiStateStore((s) => s.closeNote);
  const autoRestoreFiles = useSettingsStore((s) => s.vaultConfig?.autoRestoreFiles ?? true);

  // 当前打开的笔记从列表消失 → 区分处理：软件内重命名（切到新文件）；真删除/外部删除（关闭笔记窗口）
  useEffect(() => {
    if (!editingNote) return;
    const stillExists = vaultNoteList.some((n) => n.file === editingNote.file);
    if (!stillExists) {
      const newFile = lastNoteRenameTarget(editingNote.file);
      if (newFile) {
        setEditingNote({
          file: newFile,
          title: newFile.split("/").pop()?.replace(/\.md$/i, "") ?? newFile,
        });
      } else {
        setEditingNote(null);
      }
    }
  }, [vaultNoteList, editingNote]);
  // 窗口系统：画布 / 笔记最多各开一个窗口，主编辑区顶部窗口条切换显示
  const [activeWindow, setActiveWindow] = useState<"canvas" | "note" | null>(canvasId ? "canvas" : null);
  // 画布视口缓存（按画布隔离）：窗口切换卸载 ReactFlow，返回时恢复平移/缩放位置
  const viewportCacheRef = useRef(new Map<string, Viewport>());
  const addNode = useCanvasStore((s) => s.addNode);
  const addTextNoteFromVault = useCanvasStore((s) => s.addTextNoteFromVault);
  const addMediaFromVault = useCanvasStore((s) => s.addMediaFromVault);
  const pickAndImportAttachment = useCanvasStore((s) => s.pickAndImportAttachment);
  const toggleFullscreen = useAppStore((s) => s.toggleFullscreen);
  const minimizeWindow = useAppStore((s) => s.minimizeWindow);
  const toggleMaximizeWindow = useAppStore((s) => s.toggleMaximizeWindow);
  const closeWindow = useAppStore((s) => s.closeWindow);

  // 画布右键菜单（空白处）
  const [menu, setMenu] = useState<{ x: number; y: number; flowX: number; flowY: number; linkMode?: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // 空白右键菜单挂载后按实测尺寸钳制到视口内（防靠近窗口右/下边缘被截断）
  const { ref: menuRef, pos: menuPos } = useClampedMenuPosition(menu?.x ?? 0, menu?.y ?? 0);
  // 画布快捷键仅在画布窗口激活时启用（笔记窗口激活时 Delete/Ctrl+Z/Ctrl+A 不误操作画布）；
  // 只读白板（外部白板格式）不提供编辑快捷键
  useCanvasHotkeys(menu ? closeMenu : undefined, activeWindow === "canvas" && !readOnly);

  // 节点右键菜单
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);

  // 画布标题编辑
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Escape 取消重命名标记：拦截 input 卸载触发的 blur 误提交（review 修复）
  const renameCancelledRef = useRef(false);
  // 重命名已提交标记：Enter/失焦首次提交后，blur 二次触发的 saveTitle 直接跳过（防重名冲突时重复 rename）
  const renameCommittedRef = useRef(false);
  // 重名自动加序号的提醒（3s 后自动消失）
  const [titleNotice, setTitleNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!titleNotice) return;
    const t = setTimeout(() => setTitleNotice(null), 3000);
    return () => clearTimeout(t);
  }, [titleNotice]);

  useEffect(() => {
    if (canvasFile) load(canvasFile);
  }, [canvasFile, load]);

  // 窗口系统联动：
  // - 画布打开/切换 → 激活画布槽；笔记打开 → 激活笔记槽（双槽位常驻，打开互不关闭）
  // - 槽位关闭（文件置空）→ 激活切到仍开着文件的槽位；全部占位时默认激活画布槽（activeWindow 恒非 null）
  useEffect(() => {
    // 切画布：清空属性面板选中 + 画布重命名草稿（防残留标题误重命名新画布）
    setInspectorNodeId(null);
    setEditingTitle(false);
    setTitleDraft("");
    if (canvasId) setActiveWindow("canvas");
  }, [canvasId]);
  useEffect(() => {
    if (editingNote) setActiveWindow("note");
  }, [editingNote]);
  // 窗口标签联动：点击标题栏窗口标签切换时，展开右侧边栏并切对应 tab——
  // 笔记槽 → AI 对话 tab；画布槽 → 属性 tab（打开/关闭笔记、点击标签均走 activeWindow 变化）
  useEffect(() => {
    setShowInspector(true);
    setInspectorTab(activeWindow === "note" ? "ai" : "properties");
  }, [activeWindow]);
  // AI 对话面板会话：进工作区读盘加载；离开（回仓库选择页/切仓库）时 flush，防 debounce 窗口内丢改动
  useEffect(() => {
    void useChatPanelStore.getState().load(useAppStore.getState().vaultId);
    // cleanup 不能返回 Promise（React Destructor 类型），卸载时 fire-and-forget 即可
    return () => {
      void useChatPanelStore.getState().flush(useAppStore.getState().vaultId);
    };
  }, []);
  useEffect(() => {
    setActiveWindow((w) => {
      // 初始/未知态（null）→ 默认激活画布槽
      if (w === null) return "canvas";
      if (w === "canvas" && !canvasId) return editingNote ? "note" : "canvas";
      if (w === "note" && !editingNote) return "canvas";
      return w;
    });
  }, [canvasId, editingNote]);

  const saveTitle = useCallback(() => {
    // Escape 取消后 input 卸载触发 blur，靠 flag 拦截这次误提交（ref 同步生效，blur 闭包仍旧 draft）
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    // Enter/失焦首次提交后，input 卸载触发的二次 blur 直接跳过（防重名冲突时重复 rename/重置提醒）
    if (renameCommittedRef.current) return;
    const t = titleDraft.trim();
    if (t && t !== canvasTitle) {
      // 标题即文件名：同名自动加序号（排除自身）
      const canvases = useAppStore.getState().canvases;
      const actual = dedupeFilename(
        t,
        canvases.map((c) => c.title).filter((x) => x !== canvasTitle),
      );
      renameCanvas(actual);
      if (actual !== t) setTitleNotice(`「${t}」已存在，已重命名为「${actual}」`);
    }
    renameCommittedRef.current = true;
    setEditingTitle(false);
  }, [titleDraft, canvasTitle, renameCanvas]);

  const addConversationAt = useCallback(
    (x: number, y: number) => {
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: "conversation",
        position: { x, y },
        // 初始尺寸大一点便于多轮对话；用户可 resize 覆盖（持久化到 .atlx）
        width: DEFAULT_CONVERSATION_WIDTH,
        height: DEFAULT_CONVERSATION_HEIGHT,
        data: { providerId: "", model: "" },
      };
      addNode(newNode);
    },
    [addNode]
  );

  /** 画布空白处右键/新建：画布内文本节点（无 file，正文空，随 .atlx 内嵌；右键「保存为笔记」才落盘）。 */
  const addTextNodeAt = useCallback(
    (x: number, y: number) => {
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: "text",
        position: { x, y },
        width: DEFAULT_TEXT_NODE_WIDTH,
        height: DEFAULT_TEXT_NODE_HEIGHT,
        data: { title: "文本", bodyMd: "" },
      };
      addNode(newNode);
    },
    [addNode]
  );

  /** 画布空白处右键「添加分组」：背景矩形容器（低 zIndex，色板默认中性色）。 */
  const addGroupAt = useCallback(
    (x: number, y: number) => {
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: "group",
        position: { x, y },
        zIndex: -1,
        width: DEFAULT_GROUP_WIDTH,
        height: DEFAULT_GROUP_HEIGHT,
        data: { label: "分组" },
      };
      addNode(newNode);
    },
    [addNode]
  );

  /** 画布空白处右键「添加链接」：URL 卡片节点。 */
  const addLinkAt = useCallback(
    (x: number, y: number, url: string) => {
      const newNode: Node = {
        id: crypto.randomUUID(),
        type: "link",
        position: { x, y },
        width: DEFAULT_LINK_WIDTH,
        height: DEFAULT_LINK_HEIGHT,
        data: { url },
      };
      addNode(newNode);
    },
    [addNode]
  );

  /** 转换为画布：生成同目录 .atlx 副本并打开（原 .canvas 保留，单向转换）。只读横幅与文件面板右键共用。 */
  const handleConvertWhiteboard = useCallback(async (file: string) => {
    const row = await convertWhiteboard(file);
    if (row) {
      openCanvas(row);
      recordOpenCanvas(row.file);
      setActiveWindow("canvas");
    } else {
      useCanvasStore.setState({ error: "转换为画布失败，请重试" });
    }
  }, [convertWhiteboard, openCanvas, recordOpenCanvas]);

  // ReactFlow 容器 ref：用于取画布区中心坐标（双击 .md / 底部工具栏建节点时落点）
  const flowWrapperRef = useRef<HTMLDivElement>(null);

  const canvasCenter = useCallback(() => {
    const rect = flowWrapperRef.current?.getBoundingClientRect();
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return screenToFlowPosition(center);
  }, [screenToFlowPosition]);

  /** 底部工具栏「新建页面」：画布视图中心新建对话节点。 */
  const createConversationAtCenter = useCallback(() => {
    const pos = canvasCenter();
    addConversationAt(pos.x, pos.y);
    setTimeout(() => fitView({ duration: 200, padding: 0.2 }), 50);
  }, [canvasCenter, addConversationAt, fitView]);

  /** 底部工具栏「插入文件」：系统对话框选文件 → 导入仓库附件目录 → 画布中心建媒体节点。 */
  const handleInsertFile = useCallback(async () => {
    try {
      const pos = canvasCenter();
      await pickAndImportAttachment(pos);
    } catch (e) {
      console.error("插入文件失败", e);
    }
  }, [canvasCenter, pickAndImportAttachment]);

  /** 全屏切换（视图控制图标，经 store 转发到 services）。 */
  const handleToggleFullscreen = useCallback(() => {
    void toggleFullscreen().catch((e) => {
      console.error("全屏切换失败", e);
    });
  }, [toggleFullscreen]);

  /**
   * 画布容器原生监听 dragover/drop：绕开 React 合成事件委托（WebView2 中合成事件对
   * HTML5 DnD 的 preventDefault 不可靠 → drop 不触发 + 禁止光标）。仅消费面板拖拽（自定义
   * MIME），非面板来源（如节点输入框拖文件）放行给节点自身的 drop 处理。
   */
  useEffect(() => {
    const el = flowWrapperRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(ATELYX_FILE_MIME);
      if (!raw) return; // 非面板来源，放行给节点
      e.preventDefault();
      e.stopPropagation();
      let payload: AtelyxFilePayload;
      try {
        payload = JSON.parse(raw) as AtelyxFilePayload;
      } catch {
        return;
      }
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (payload.kind === "note") {
        void addTextNoteFromVault(payload.file, payload.title ?? payload.name, pos, true);
      } else {
        void addMediaFromVault(payload.file, payload.name, pos, true);
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
    };
  }, [canvasId, screenToFlowPosition, addTextNoteFromVault, addMediaFromVault]);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      // 只读白板（外部白板格式）：无新建入口
      if (useCanvasStore.getState().readOnly) return;
      // 右键空白 = 取消节点选中（与左键 onPaneClick 一致）
      setInspectorNodeId(null);
      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setMenu({ x: event.clientX, y: event.clientY, flowX: pos.x, flowY: pos.y });
    },
    [screenToFlowPosition]
  );

  const onNodeContextMenuInternal = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      // 只读白板（外部白板格式）：节点不可编辑/删除，不提供右键菜单
      if (useCanvasStore.getState().readOnly) return;
      // 右键节点同步选中到属性面板（右键菜单操作对象 = 面板展示对象）
      setInspectorNodeId(node.id);
      setNodeMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
    },
    []
  );

  // 属性面板选中：左键单击节点选中、单击空白清空（与右键行为对称）
  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setInspectorNodeId(node.id);
  }, []);
  const handlePaneClick = useCallback(() => {
    setInspectorNodeId(null);
  }, []);

  /** 单击文件面板画布 → 打开并激活画布窗口（与 handleOpenNoteEditor 对称：再点已打开的文件也切回画布窗口）。 */
  const handleOpenCanvasFile = useCallback((row: CanvasFileRow) => {
    openCanvas(row);
    recordOpenCanvas(row.file);
    setActiveWindow("canvas");
  }, [openCanvas, recordOpenCanvas]);

  /** 单击文件面板笔记 → 打开笔记窗口并激活。 */
  const handleOpenNoteEditor = useCallback((file: string, title: string) => {
    setEditingNote({ file, title });
    recordOpenNote(file);
    setActiveWindow("note");
  }, [recordOpenNote]);

  /** 关闭画布窗口：槽位占位化（canvasId 置 null、标签保留为「画布」），不切相邻画布。 */
  const handleCloseCanvasWindow = useCallback(() => {
    closeCanvasFile();
    closeUiCanvas();
  }, [closeCanvasFile, closeUiCanvas]);

  /** 关闭笔记窗口（激活联动在 useEffect：画布开着则切回画布）。 */
  const handleCloseNoteWindow = useCallback(() => {
    setEditingNote(null);
    closeUiNote();
  }, [closeUiNote]);

  /** 进仓库后恢复上次打开的文件（设置「自动恢复上次打开的文件」开启时；）。
   * 依赖 uiLoaded（uiState 已从磁盘加载）+ canvases/noteList（文件树已刷新）就绪后才执行，
   * 文件已被外部删除/移动则静默跳过（降级占位态，不报错）。 */
  useEffect(() => {
    if (!uiLoaded) return;
    if (!autoRestoreFiles) return;
    const store = useAppStore.getState();
    // 画布：lastCanvasFile 能在当前画布列表命中才打开（文件缺失/已删除则跳过）；
    // 外部白板（.canvas）不在画布列表，从文件树命中后合成行打开（只读查看）
    if (lastCanvasFile && !store.currentCanvasFile) {
      const row = store.canvases.find((c) => c.file === lastCanvasFile);
      if (row) {
        openCanvas(row);
      } else if (lastCanvasFile.toLowerCase().endsWith(".canvas")) {
        const hit = findFileInTree(useVaultStore.getState().tree, lastCanvasFile);
        if (hit) {
          openCanvas({
            id: hit.path,
            title: hit.name.replace(/\.canvas$/i, ""),
            file: hit.path,
            updatedAt: hit.updatedAt,
          });
        }
      }
    }
    // 笔记：lastNoteFile 能在笔记列表命中才打开（文件缺失/已删除则跳过）
    if (lastNoteFile && !editingNote) {
      const note = vaultNoteList.find((n) => n.file === lastNoteFile);
      if (note) setEditingNote({ file: note.file, title: note.name.replace(/\.md$/i, "") });
    }
    // 恢复后按上次激活窗口激活；openCanvas/setEditingNote 的联动 effect 会无条件激活对应窗口，
    // 用 setTimeout 兜底让联动 effect 先跑完再最终覆盖（lastActiveWindow 优先级最高）
    const t = setTimeout(() => setActiveWindow(lastActiveWindow ?? "canvas"), 0);
    return () => clearTimeout(t);
  }, [uiLoaded, autoRestoreFiles, lastCanvasFile, lastNoteFile, openCanvas, vaultNoteList, editingNote, lastActiveWindow]);

  // 记录激活窗口变化（标题栏标签切换/打开文件联动均走 activeWindow）：写回 uiStateStore 供下次恢复
  useEffect(() => {
    if (activeWindow === "canvas" || activeWindow === "note") {
      recordActiveWindow(activeWindow);
    }
  }, [activeWindow, recordActiveWindow]);

  /**
   * 左列宽度百分比：映射 PanelGroup onLayout 数组（加 id/order 后顺序稳定 = 左/中/右存在项）。
   * colPct 长度与当前面板数不匹配（折叠/展开瞬间可能还是旧数组）→ 回退 defaultSize，防标签错位。
   */
  const leftPct = (): number => {
    const expectedPanels = (leftPanel !== null ? 1 : 0) + 1 + (showInspector ? 1 : 0);
    if (colPct.length !== expectedPanels) return leftPanel !== null ? 24 : 0;
    return leftPanel !== null ? (colPct[0] ?? 0) : 0;
  };

  // 标题栏横条所在容器（横条 + 主体 PanelGroup 共用的 flex-col）宽度：标签区 margin-left 对齐编辑区左缘需要像素值
  const titlebarAreaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(0);
  // 首帧 paint 前同步测量（ResizeObserver 首回调在 commit 后，直接用它会有 1 帧闪到最左）
  useLayoutEffect(() => {
    const el = titlebarAreaRef.current;
    if (el) setAreaWidth(el.clientWidth);
  }, []);
  useEffect(() => {
    const el = titlebarAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // react-resizable-panels 的 pct 基于「组宽 - 全部 handle 宽」（每个 w-1 handle = 4px）
  const handleWidths = (leftPanel !== null ? 4 : 0) + (showInspector ? 4 : 0);
  // 横条 pl-1(4px) 使标签区自然从 4px 开始；目标左缘 = 画布左缘 = 左列像素宽 + 左 handle(4)
  // （折叠/展开走 ActivityBar 最左图标）
  const tabStripMarginLeft = (leftPct() / 100) * (areaWidth - handleWidths) + (leftPanel !== null ? 4 : 0) - 4;

  return (
    <div
      className="h-full w-full flex flex-col"
      style={{ background: "var(--bg-primary)" }}
      onClick={() => { closeMenu(); closeNodeMenu(); }}
    >

      {/* ===== 主体：最左功能栏 + 标题栏横条（三区联动下方列宽）+ 三列 PanelGroup + 窗口控制 ===== */}
      <div className="flex-1 flex min-h-0">
        <ActivityBar
          filesActive={leftPanel === "files"}
          onToggleFiles={() => setLeftPanel((v) => (v === "files" ? null : "files"))}
          searchActive={leftPanel === "search"}
          onToggleSearch={() => setLeftPanel((v) => (v === "search" ? null : "search"))}
          aiActive={showInspector && inspectorTab === "ai"}
          onOpenAiChat={() => {
            // 已激活（边栏展开 + AI 对话 tab）时再次点击 = 收起右侧边栏；否则展开并切到 AI 对话 tab
            if (showInspector && inspectorTab === "ai") {
              setShowInspector(false);
            } else {
              setShowInspector(true);
              setInspectorTab("ai");
            }
          }}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div ref={titlebarAreaRef} className="flex-1 flex flex-col min-w-0">
          {/* 标题栏横条：一条横贯（bg-secondary + 底边线）。折叠按钮 → 标签区（margin-left 对齐编辑区左缘）→ ml-auto 状态区 → 右操作区（属性折叠/全屏/窗口控制，常驻） */}
          <div
            className="h-9 flex items-center gap-1 pl-1 pr-1 flex-shrink-0 select-none"
            style={{ background: "var(--bg-secondary)", borderBottom: "1px solid var(--border)" }}
            data-tauri-drag-region
          >
            {/* 窗口标签区（双槽位常驻）：画布/笔记；文件态显示全名含后缀 + 关闭按钮，占位态显示「画布」「笔记」且隐藏关闭按钮 */}
            <div className="h-full flex items-stretch gap-1" style={{ marginLeft: tabStripMarginLeft }} data-tauri-drag-region>
              {/* 画布槽 */}
              <WindowTab
                title={canvasId ? `${canvasTitle || "未命名画布"}${canvasFile?.toLowerCase().endsWith(".canvas") ? ".canvas" : ".atlx"}` : "画布"}
                active={activeWindow === "canvas"}
                onSelect={() => setActiveWindow("canvas")}
                onClose={canvasId ? handleCloseCanvasWindow : undefined}
                editing={editingTitle}
                draft={titleDraft}
                onDraftChange={setTitleDraft}
                onDraftCommit={saveTitle}
                onDraftCancel={() => { renameCancelledRef.current = true; setEditingTitle(false); }}
                onStartRename={canvasId && !readOnly ? () => { renameCancelledRef.current = false; renameCommittedRef.current = false; setTitleDraft(canvasTitle); setEditingTitle(true); } : undefined}
              />
              {/* 笔记槽 */}
              <WindowTab
                title={editingNote ? `${editingNote.title}.md` : "笔记"}
                active={activeWindow === "note"}
                onSelect={() => setActiveWindow("note")}
                onClose={editingNote ? handleCloseNoteWindow : undefined}
              />
            </div>

            {/* 画布状态区（ml-auto 贴右操作区左侧；画布窗口开着即显示，切笔记不遗漏冲突/错误提示） */}
            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0 px-1" data-tauri-drag-region>
              {canvasId && (
                <span className="flex-shrink-0 text-xs">
                  {loading ? "加载中…" : saving ? "保存中…" : readOnly ? "只读（外部白板格式）" : "已自动保存"}
                </span>
              )}
              {canvasId && titleNotice && (
                <span
                  className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded"
                  style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
                >
                  {titleNotice}
                </span>
              )}
              {canvasId && conflictPending && (
                <span
                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{ color: "#f59e0b", background: "rgba(245,158,11,0.1)" }}
                >
                  画布与外部修改冲突（本地有未保存改动）
                  <button
                    onClick={(e) => { e.stopPropagation(); void mergeFromDisk(); }}
                    className="px-1 rounded hover:opacity-80"
                    style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
                    title="以磁盘为基底保留本地新增内容（重叠以磁盘为准）"
                    data-tauri-drag-region="false"
                  >
                    合并
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void reloadFromDisk(); }}
                    className="px-1 rounded hover:opacity-80"
                    style={{ background: "rgba(245,158,11,0.2)", color: "#f59e0b" }}
                    data-tauri-drag-region="false"
                  >
                    重载（丢弃本地）
                  </button>
                </span>
              )}
              {canvasId && canvasError && (
                <span
                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{ color: "#f87171", background: "rgba(248,113,113,0.1)" }}
                >
                  <span className="truncate max-w-[220px]">{canvasError}</span>
                  {canvasError === "加载画布失败，请重试" && canvasId && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void load(canvasId); }}
                      className="px-1 rounded hover:opacity-80"
                      style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
                      data-tauri-drag-region="false"
                    >
                      重试
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); clearError(); }}
                    className="px-1 rounded hover:opacity-80"
                    style={{ background: "rgba(248,113,113,0.2)", color: "#f87171" }}
                    aria-label="关闭错误提示"
                    data-tauri-drag-region="false"
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
            </div>

            {/* 右操作区（常驻，不随属性面板折叠消失）：属性面板折叠 + 全屏 */}
            <div className="flex-shrink-0 flex items-center" data-tauri-drag-region>
              <button
                onClick={(e) => { e.stopPropagation(); setShowInspector((v) => !v); }}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:opacity-80"
                style={{ color: showInspector ? "var(--accent)" : "var(--text-secondary)" }}
                title={showInspector ? "隐藏属性面板" : "显示属性面板"}
                data-tauri-drag-region="false"
              >
                {showInspector ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void handleToggleFullscreen(); }}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:opacity-80"
                style={{ color: "var(--text-secondary)" }}
                title="全屏"
                data-tauri-drag-region="false"
              >
                <Maximize size={16} />
              </button>
            </div>
            <TitleBarControls
              onMinimize={() => void minimizeWindow()}
              onMaximize={() => void toggleMaximizeWindow()}
              onClose={() => void closeWindow()}
            />
          </div>

          <PanelGroup onLayout={setColPct} direction="horizontal" className="flex-1 min-w-0">
          {leftPanel !== null && (
            <>
              <Panel id="file-panel" order={0} defaultSize={20} minSize={14} className="min-w-0">
                {leftPanel === "files" ? (
                  <FileExplorerPanel
                    onOpenCanvasFile={handleOpenCanvasFile}
                    onOpenNoteForEdit={handleOpenNoteEditor}
                    openedNoteFile={editingNote?.file ?? null}
                    onConvertWhiteboard={(file) => void handleConvertWhiteboard(file)}
                  />
                ) : (
                  <SearchPanel
                    onOpenCanvasFile={handleOpenCanvasFile}
                    onOpenNoteForEdit={handleOpenNoteEditor}
                  />
                )}
              </Panel>
              <PanelResizeHandle
                className="w-1 flex-shrink-0 transition-colors hover:bg-[var(--accent)]/50"
                style={{ background: "var(--border)" }}
              />
            </>
          )}
          <Panel id="editor-panel" order={1} defaultSize={55} minSize={15} className="min-w-0">
            <div className="h-full flex flex-col">
              {/* 画布区 */}
              <div className="flex-1 relative min-h-0">
                {activeWindow === "note" ? (
                  /* 笔记槽激活：有文件 → 笔记编辑器；占位 → 打开提示 */
                  editingNote ? (
                    <NoteEditor key={editingNote.file} file={editingNote.file} />
                  ) : (
                    <div
                      className="h-full w-full flex items-center justify-center"
                      style={{ background: "var(--bg-primary)" }}
                    >
                      <div className="flex flex-col items-center gap-4 max-w-sm text-center px-6">
                        <div className="opacity-60"><FileText size={64} strokeWidth={1.5} /></div>
                        <h2
                          className="text-xl font-semibold"
                          style={{ color: "var(--text-primary)" }}
                        >
                          打开笔记
                        </h2>
                        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                          从左侧文件面板或搜索面板单击一个 .md 笔记开始编辑。
                        </p>
                      </div>
                    </div>
                  )
                ) : canvasId ? (
                  <div
                    ref={flowWrapperRef}
                    className="h-full w-full"
                    onContextMenu={(e) => {
                      if ((e.target as HTMLElement).closest(".react-flow__node")) return;
                      onPaneContextMenu(e);
                    }}
                  >
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      onConnect={onConnect}
                      onNodeDragStart={onNodeDragStart}
                      onNodeDragStop={onNodeDragStop}
                      onNodeClick={handleNodeClick}
                      onPaneClick={handlePaneClick}
                      onNodeContextMenu={onNodeContextMenuInternal}
                      onMoveEnd={(_event, viewport) => {
                        // 记录当前画布视口，窗口切换卸载 ReactFlow 后返回时恢复（onInit）
                        if (canvasId) viewportCacheRef.current.set(canvasId, viewport);
                      }}
                      onInit={(instance) => {
                        if (canvasId) {
                          const vp = viewportCacheRef.current.get(canvasId);
                          if (vp) instance.setViewport(vp);
                        }
                      }}
                      isValidConnection={isValidConnection}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      fitView
                      minZoom={0.1}
                      maxZoom={2}
                      panOnDrag={[1, 2]}
                      panActivationKeyCode="Space"
                      snapToGrid={snapEnabled}
                      snapGrid={[16, 16]}
                      // 只读白板（外部白板格式）：禁拖拽/连线；关联边需任意 handle 组合（Loose，
                      // 边类型由两端节点自动分类，方向仍由拖出端决定）
                      nodesDraggable={!readOnly}
                      nodesConnectable={!readOnly}
                      edgesReconnectable={!readOnly}
                      connectionMode={ConnectionMode.Loose}
                    >
                      {showGrid && <Background gap={16} />}
                      {/* 画布右侧中部悬浮按钮组：网格 / 磁铁吸附（竖排，react-flow__controls 样式） */}
                      <FlowPanel position="center-right">
                        <div className="react-flow__controls">
                          <ControlButton
                            title="显示网格"
                            aria-label="显示网格"
                            onClick={() => setShowGrid((v) => !v)}
                            style={{ width: 36, height: 36, color: showGrid ? "var(--accent)" : undefined }}
                          >
                            <Grid3x3 size={18} />
                          </ControlButton>
                          <ControlButton
                            title={snapEnabled ? "关闭网格吸附" : "开启网格吸附"}
                            aria-label="网格吸附"
                            onClick={() => setSnapEnabled((v) => !v)}
                            style={{ width: 36, height: 36, color: snapEnabled ? "var(--accent)" : undefined }}
                          >
                            <Magnet size={18} />
                          </ControlButton>
                        </div>
                      </FlowPanel>
                      {/* 左下角按钮组：放大/缩小/适应视图（bottom 上调避开状态栏统计） */}
                      <FlowPanel position="bottom-left" style={{ bottom: 32 }}>
                        <div className="react-flow__controls">
                          <ControlButton title="放大 (+)" onClick={() => zoomIn({ duration: 150 })}>
                            <Plus size={16} />
                          </ControlButton>
                          <ControlButton title="缩小 (-)" onClick={() => zoomOut({ duration: 150 })}>
                            <Minus size={16} />
                          </ControlButton>
                          <ControlButton title="适应视图" onClick={() => fitView({ duration: 200, padding: 0.15 })}>
                            <Maximize size={16} />
                          </ControlButton>
                        </div>
                      </FlowPanel>
                      {/* 点击小地图任意处 → 视口中心快速跳转到该画布位置（React Flow 12 默认不跳转，需自定义 onClick） */}
                      <MiniMap
                        pannable
                        zoomable
                        nodeBorderRadius={4}
                        onClick={(_, position) => setCenter(position.x, position.y, { duration: 200 })}
                        style={{ bottom: 16, right: 16, width: 170, height: 130 }}
                      />
                    </ReactFlow>

                    {/* 只读白板横幅：外部白板格式只读查看 + 转换为画布入口（原文件保留，单向转换） */}
                    {readOnly && (
                      <div
                        className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
                        style={{ background: "var(--bg-tertiary)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
                      >
                        <span>只读查看 · 外部白板格式</span>
                        <button
                          onClick={() => void handleConvertWhiteboard(canvasFile!)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded transition-colors"
                          style={{ background: "rgba(212,175,55,0.15)", color: "var(--accent)" }}
                          title="生成同目录 .atlx 画布副本并打开（原文件保留）"
                        >
                          <FileOutput size={13} /> 转换为画布
                        </button>
                      </div>
                    )}

                    {/* 底部居中工具栏：新建页面 / 插入文件 / 模板库（只读白板隐藏） */}
                    {!readOnly && (
                      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex gap-1.5">
                        <SquareToolButton title="新建对话节点" onClick={createConversationAtCenter}>
                          <MessageSquarePlus size={16} />
                        </SquareToolButton>
                        <SquareToolButton title="插入文件（导入到附件目录）" onClick={() => void handleInsertFile()}>
                          <FilePlus size={16} />
                        </SquareToolButton>
                        <SquareToolButton title="模板库（尚未支持）" disabled>
                          <LayoutTemplate size={16} />
                        </SquareToolButton>
                      </div>
                    )}

                    {/* 左下角状态栏：统计（右下角让位 MiniMap；网格按钮已并入左下角按钮组） */}
                    <div
                      className="absolute bottom-1.5 left-3 z-10 text-[11px] select-none inline-flex items-center gap-1.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <span>{nodes.length} 个节点 · {edges.length} 条连线</span>
                      <ZoomBadge />
                    </div>
                  </div>
                ) : (
                  /* 画布槽占位：提示从左侧文件面板打开画布（与笔记占位同款，无按钮） */
                  <div
                    className="h-full w-full flex items-center justify-center"
                    style={{ background: "var(--bg-primary)" }}
                  >
                    <div className="flex flex-col items-center gap-4 max-w-sm text-center px-6">
                      <div className="opacity-60"><Palette size={64} strokeWidth={1.5} /></div>
                      <h2
                        className="text-xl font-semibold"
                        style={{ color: "var(--text-primary)" }}
                      >
                        打开画布
                      </h2>
                      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                        从左侧文件面板或搜索面板单击一个 .atlx 画布开始编辑。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
          {showInspector && (
            <>
              <PanelResizeHandle
                className="w-1 flex-shrink-0 transition-colors hover:bg-[var(--accent)]/50"
                style={{ background: "var(--border)" }}
              />
              {/* 右侧边栏：默认 25%（20:55:25 布局的「25」）；minSize 22% 保证 AI 对话工具条按钮不被挤压 */}
              <Panel id="inspector-panel" order={2} defaultSize={25} minSize={22} maxSize={40} className="min-w-0">
                {/* 右侧边栏：双 tab——节点属性 / AI 对话（打开笔记自动切 AI 对话，） */}
                <div className="h-full flex flex-col" style={{ background: "var(--bg-secondary)" }}>
                  <div
                    className="flex flex-shrink-0 border-b"
                    style={{ borderColor: "var(--border)" }}
                    data-tauri-drag-region
                  >
                    <button
                      onClick={() => setInspectorTab("properties")}
                      className="flex-1 py-1.5 text-xs border-b-2 transition-colors"
                      style={{
                        color: inspectorTab === "properties" ? "var(--text-primary)" : "var(--text-muted)",
                        borderColor: inspectorTab === "properties" ? "var(--accent)" : "transparent",
                      }}
                      data-tauri-drag-region="false"
                    >
                      属性
                    </button>
                    <button
                      onClick={() => setInspectorTab("ai")}
                      className="flex-1 py-1.5 text-xs border-b-2 transition-colors"
                      style={{
                        color: inspectorTab === "ai" ? "var(--text-primary)" : "var(--text-muted)",
                        borderColor: inspectorTab === "ai" ? "var(--accent)" : "transparent",
                      }}
                      data-tauri-drag-region="false"
                    >
                      AI 对话
                    </button>
                  </div>
                  {inspectorTab === "ai" ? (
                    // noteFile 仅在笔记窗口激活时传入（切到画布标签即使笔记还开着也不注入）；
                    // onOpenNote = 用户消息 @chip 点击打开对应笔记（与文件面板单击笔记一致）
                    <AiChatPanel
                      noteFile={activeWindow === "note" ? editingNote?.file ?? null : null}
                      onOpenNote={handleOpenNoteEditor}
                    />
                  ) : (
                    <InspectorPanel nodeId={inspectorNodeId} />
                  )}
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
        </div>
      </div>

      {/* 画布空白处右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed border rounded shadow-lg py-1 z-50 w-40"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            background: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.linkMode ? (
            /* 添加链接：菜单内 inline 输入 URL（Enter 创建，Esc 关闭） */
            <div className="px-3 py-1.5">
              <input
                autoFocus
                placeholder="https://…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const url = (e.target as HTMLInputElement).value.trim();
                    if (url) addLinkAt(menu.flowX, menu.flowY, url);
                    closeMenu();
                  } else if (e.key === "Escape") {
                    closeMenu();
                  }
                }}
                onBlur={closeMenu}
                className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-xs"
                style={{ color: "var(--text-primary)" }}
              />
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  addConversationAt(menu.flowX, menu.flowY);
                  closeMenu();
                  setTimeout(() => fitView({ duration: 200, padding: 0.2 }), 50);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <MessageSquarePlus size={14} /> 添加对话节点
                </span>
              </button>
              <button
                onClick={() => {
                  addTextNodeAt(menu.flowX, menu.flowY);
                  closeMenu();
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <FileText size={14} /> 添加文本节点
                </span>
              </button>
              <hr className="my-1" style={{ borderColor: "var(--border)" }} />
              <button
                onClick={() => {
                  addGroupAt(menu.flowX, menu.flowY);
                  closeMenu();
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <LayoutDashboard size={14} /> 添加分组
                </span>
              </button>
              <button
                onClick={() => setMenu((m) => (m ? { ...m, linkMode: true } : m))}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Link2 size={14} /> 添加链接
                </span>
              </button>
            </>
          )}
        </div>
      )}

      {/* 节点右键菜单 */}
      {nodeMenu && (
        <NodeContextMenu
          nodeId={nodeMenu.nodeId}
          x={nodeMenu.x}
          y={nodeMenu.y}
          onClose={closeNodeMenu}
        />
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/**
 * 标题栏窗口标签：画布/笔记窗口的标题 + 关闭按钮（双槽位常驻）。
 * 点击标题切换激活窗口（激活 tab 背景与编辑区同色、同色底边框顶开标题栏线 → 与编辑区粘连）；
 * 画布 tab 双击标题进入重命名（inline input，同文件面板交互）。
 * 占位态（无文件）：标题为「画布」/「笔记」，onClose 为 undefined → 关闭按钮隐藏。
 */
function WindowTab({
  title,
  active,
  onSelect,
  onClose,
  editing,
  draft,
  onDraftChange,
  onDraftCommit,
  onDraftCancel,
  onStartRename,
}: {
  title: string;
  active: boolean;
  onSelect: () => void;
  /** 占位态（无文件）为 undefined → 隐藏关闭按钮。 */
  onClose?: () => void;
  editing?: boolean;
  draft?: string;
  onDraftChange?: (v: string) => void;
  onDraftCommit?: () => void;
  onDraftCancel?: () => void;
  onStartRename?: () => void;
}) {
  return (
    <div
      className="group flex items-center rounded-t-md text-xs min-w-0 flex-shrink-0"
      style={{
        // 激活 tab 背景与编辑区同色（bg-primary）+ 同色底边框「顶开」标题栏底边线 → 与编辑区域粘连
        background: active ? "var(--bg-primary)" : "transparent",
        borderBottom: active ? "1px solid var(--bg-primary)" : undefined,
        color: active ? "var(--text-primary)" : "var(--text-muted)",
      }}
    >
      {editing ? (
        <input
          value={draft}
          onChange={(e) => onDraftChange?.(e.target.value)}
          onBlur={onDraftCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDraftCommit?.();
            if (e.key === "Escape") onDraftCancel?.();
          }}
          autoFocus
          className="pl-3 pr-1 py-0.5 bg-transparent border-b border-[var(--accent)] outline-none text-xs min-w-0"
          style={{ color: "var(--text-primary)" }}
          data-tauri-drag-region="false"
        />
      ) : (
        <button
          onClick={onSelect}
          onDoubleClick={onStartRename}
          className="pl-3 pr-2 py-0.5 truncate max-w-[160px] min-w-[64px] text-left"
          title={onStartRename ? `${title}（点击切换 / 双击重命名）` : title}
          data-tauri-drag-region="false"
        >
          {title}
        </button>
      )}
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="关闭窗口"
          aria-label={`关闭 ${title}`}
          className="px-2 py-0.5 hover:opacity-70 flex-shrink-0"
          data-tauri-drag-region="false"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** 缩放百分比指示（独立小组件订阅 viewport，避免平移/缩放导致整个页面重渲染）。 */
function ZoomBadge() {
  const { zoom } = useViewport();
  return <span>{Math.round(zoom * 100)}%</span>;
}

/** 在文件树中按相对路径查找文件（恢复上次打开的外部白板用，.canvas 不在画布列表）。 */
function findFileInTree(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir) {
      const hit = findFileInTree(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** 底部工具栏方形按钮。 */
function SquareToolButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-9 h-9 rounded-lg border flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
        color: "var(--text-secondary)",
      }}
    >
      {children}
    </button>
  );
}
