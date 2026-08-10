/**
 * 工作区页面（Blender 式可自定义布局）。
 *
 * 全局 chrome：标题栏（仓库名 + 布局 tabs + 画布状态区 + 右操作区（设置/全屏/窗口控制））。
 * 面积网格由 `WorkspaceGrid` 按激活布局渲染，
 * 文件打开/关闭/恢复联动在此层（跨 store 一致性），视图渲染全在面积内部。
 */
import { Maximize, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTableStore } from "@/stores/tableStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { useVaultStore, lastFolderRenameTarget, lastNoteRenameTarget, lastTableRenameTarget } from "@/stores/vaultStore";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { TitleBarControls } from "@/components/common/TitleBarControls";
import { LayoutTabs } from "@/components/layout/LayoutTabs";
import { WorkspaceGrid } from "@/components/layout/WorkspaceGrid";
import { noteTitleFromFile, tableTitleFromFile } from "@/utils/filename";
import type { FileTreeNode } from "@/types";

export function ProjectWorkspacePage() {
  const [showSettings, setShowSettings] = useState(false);

  // 标题栏画布状态区（画布开着即显示；面积网格内画布面积可能不存在，状态区在全局 chrome）
  const canvasId = useAppStore((s) => s.currentCanvasId);
  const canvasFile = useAppStore((s) => s.currentCanvasFile);
  const loading = useCanvasStore((s) => s.loading);
  const saving = useCanvasStore((s) => s.saving);
  const readOnly = useCanvasStore((s) => s.readOnly);
  const canvasError = useCanvasStore((s) => s.error);
  const clearError = useCanvasStore((s) => s.clearError);
  const conflictPending = useCanvasStore((s) => s.conflictPending);
  const reloadFromDisk = useCanvasStore((s) => s.reloadFromDisk);
  const mergeFromDisk = useCanvasStore((s) => s.mergeFromDisk);
  const loadCanvas = useCanvasStore((s) => s.load);

  const toggleFullscreen = useAppStore((s) => s.toggleFullscreen);
  const minimizeWindow = useAppStore((s) => s.minimizeWindow);
  const toggleMaximizeWindow = useAppStore((s) => s.toggleMaximizeWindow);
  const closeWindow = useAppStore((s) => s.closeWindow);

  // 当前打开文件状态（面积渲染入口；打开动作在 appStore，联动 effect 在此层）
  const currentCanvasFile = useAppStore((s) => s.currentCanvasFile);
  const currentNoteFile = useAppStore((s) => s.currentNoteFile);
  const currentTableFile = useAppStore((s) => s.currentTableFile);

  const vaultNoteList = useVaultStore((s) => s.noteList);
  const vaultTableList = useVaultStore((s) => s.tableList);

  // 应用级 UI 使用状态：上次打开的画布/笔记/表格，进仓库自动恢复
  const uiLoaded = useUiStateStore((s) => s.loaded);
  const lastCanvasFile = useUiStateStore((s) => s.lastCanvasFile);
  const lastNoteFile = useUiStateStore((s) => s.lastNoteFile);
  const lastTableFile = useUiStateStore((s) => s.lastTableFile);
  const autoRestoreFiles = useSettingsStore((s) => s.vaultConfig?.autoRestoreFiles ?? true);

  // 当前打开的文件状态与激活布局（面积网格渲染入口）
  const activeLayoutId = useUiStateStore((s) => s.activeLayoutId);
  const activeTree = useUiStateStore((s) => {
    const layout =
      s.workspaceLayouts.find((l) => l.id === s.activeLayoutId) ?? s.workspaceLayouts[0];
    return layout.tree;
  });

  // 当前打开的笔记从列表消失 → 区分处理：软件内重命名/文件夹重命名（切到新文件）；真删除/外部删除（关闭笔记）
  useEffect(() => {
    if (!currentNoteFile) return;
    const stillExists = vaultNoteList.some((n) => n.file === currentNoteFile);
    if (!stillExists) {
      const newFile =
        lastNoteRenameTarget(currentNoteFile) ?? lastFolderRenameTarget(currentNoteFile);
      if (newFile) {
        useAppStore.getState().openNote(
          newFile,
          noteTitleFromFile(newFile),
        );
      } else {
        useAppStore.getState().closeNote();
      }
    }
  }, [vaultNoteList, currentNoteFile]);
  // 当前打开的表格从列表消失 → 同笔记：软件内重命名/文件夹重命名切到新文件（重载内容）；
  // 真删除/外部删除静默关闭（不 flush——防写回重建已删文件，只清内存态）
  useEffect(() => {
    if (!currentTableFile) return;
    const stillExists = vaultTableList.some((t) => t.file === currentTableFile);
    if (!stillExists) {
      const newFile =
        lastTableRenameTarget(currentTableFile) ?? lastFolderRenameTarget(currentTableFile);
      if (newFile) {
        const newTitle = tableTitleFromFile(newFile);
        useAppStore.getState().openTable(newFile, newTitle);
      } else {
        useAppStore.getState().closeTableSilent();
      }
    }
  }, [vaultTableList, currentTableFile]);

  // AI 对话面板会话：进工作区读盘加载；离开（回仓库选择页/切仓库）时 flush，防 debounce 窗口内丢改动
  useEffect(() => {
    void useChatPanelStore.getState().load(useAppStore.getState().vaultId);
    // cleanup 不能返回 Promise（React Destructor 类型），卸载时 fire-and-forget 即可
    return () => {
      void useChatPanelStore.getState().flush(useAppStore.getState().vaultId);
    };
  }, []);

  // 页面卸载（切仓库/回启动页）：flush 表格改动，防 debounce 窗口内丢
  useEffect(() => {
    return () => {
      void useTableStore.getState().flush();
    };
  }, []);

  /** 进仓库后恢复上次打开的文件（设置「自动恢复上次打开的文件」开启时）。
   * 依赖 uiLoaded（uiState 已从磁盘加载）+ canvases/noteList（文件树已刷新）就绪后才执行，
   * 文件已被外部删除/移动则静默跳过（降级占位，不报错）。
   * openCanvas/openNote/openTable 内部记录「上次打开」；聚焦由 WorkspaceGrid 兜底。 */
  useEffect(() => {
    if (!uiLoaded) return;
    if (!autoRestoreFiles) return;
    const store = useAppStore.getState();
    // 画布：lastCanvasFile 能在当前画布列表命中才打开（文件缺失/已删除则跳过）；
    // 外部白板（.canvas）不在画布列表，从文件树命中后合成行打开（只读查看）
    if (lastCanvasFile && !store.currentCanvasFile) {
      const row = store.canvases.find((c) => c.file === lastCanvasFile);
      if (row) {
        store.openCanvas(row);
      } else if (lastCanvasFile.toLowerCase().endsWith(".canvas")) {
        const hit = findFileInTree(useVaultStore.getState().tree, lastCanvasFile);
        if (hit) {
          store.openCanvas({
            id: hit.path,
            title: hit.name.replace(/\.canvas$/i, ""),
            file: hit.path,
            updatedAt: hit.updatedAt,
          });
        }
      }
    }
    // 笔记：lastNoteFile 能在笔记列表命中才打开（文件缺失/已删除则跳过）
    if (lastNoteFile && !store.currentNoteFile) {
      const note = vaultNoteList.find((n) => n.file === lastNoteFile);
      if (note) store.openNote(note.file, note.name.replace(/\.md$/i, ""));
    }
    // 表格：lastTableFile 能在表格列表命中才打开（文件缺失/已删除则跳过）
    if (lastTableFile && !store.currentTableFile) {
      const table = vaultTableList.find((t) => t.file === lastTableFile);
      if (table) store.openTable(table.file, table.name.replace(/\.atb$/i, ""));
    }
  }, [
    uiLoaded,
    autoRestoreFiles,
    lastCanvasFile,
    lastNoteFile,
    lastTableFile,
    vaultNoteList,
    vaultTableList,
    currentCanvasFile,
    currentNoteFile,
    currentTableFile,
  ]);

  /** 全屏切换（视图控制图标，经 store 转发到 services）。 */
  const handleToggleFullscreen = () => {
    void toggleFullscreen().catch((e) => {
      console.error("全屏切换失败", e);
    });
  };

  return (
    <div
      className="h-full w-full flex flex-col"
      style={{ background: "var(--bg-primary)" }}
    >
      <div className="flex-1 flex flex-col min-h-0">
        {/* 标题栏横条：仓库名 + 布局 tabs → ml-auto 状态区 → 右操作区（设置/全屏/窗口控制，常驻） */}
        <div
          className="h-9 flex items-center gap-1 pl-1 pr-1 flex-shrink-0 select-none"
          style={{ background: "var(--bg-secondary)", borderBottom: "1px solid var(--border)" }}
          data-tauri-drag-region
        >
          <LayoutTabs />

            {/* 画布状态区（ml-auto 贴右操作区左侧；画布开着即显示，切笔记不遗漏冲突/错误提示） */}
            <div className="ml-auto flex items-center gap-1.5 flex-shrink-0 px-1" data-tauri-drag-region>
              {canvasId && (
                <span className="flex-shrink-0 text-xs">
                  {loading ? "加载中…" : saving ? "保存中…" : readOnly ? "只读（外部白板格式）" : "已自动保存"}
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
                  {canvasError === "加载画布失败，请重试" && canvasFile && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void loadCanvas(canvasFile); }}
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

            {/* 右操作区（常驻）：设置 + 全屏 */}
            <div className="flex-shrink-0 flex items-center" data-tauri-drag-region>
              <button
                onClick={(e) => { e.stopPropagation(); setShowSettings(true); }}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:opacity-80"
                style={{ color: "var(--text-secondary)" }}
                title="设置"
                data-tauri-drag-region="false"
              >
                <Settings size={16} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleToggleFullscreen(); }}
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

          {/* 面积网格（激活布局；key 保证切布局整树重挂，defaultSize 恢复各面积比例） */}
          <div className="flex-1 min-h-0">
            <WorkspaceGrid key={activeLayoutId ?? "default"} tree={activeTree} />
          </div>
        </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
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
