/**
 * 应用级 UI 使用状态。
 *
 * 持有跨会话恢复所需的使用数据，独立落盘 `app_data_dir/ui-state.json`
 * （与全局配置 global.json 分离，高频展开/折叠/布局拖拽写入抖动不进配置）：
 * - 工作区布局（布局列表 + 激活布局 + 聚焦面积，见 `types/workspaceLayout.ts`）；
 * - 上次打开的画布/笔记/表格文件（设置「自动恢复上次打开的文件」开启时恢复）；
 * - 文件面板展开的文件夹集合（进入仓库自动恢复上次展开情况）。
 *
 * **应用级、跨仓库共享**：app_data_dir 本机独有、不随仓库同步，无需按设备分桶；
 * 切仓库不清空、不重载（布局/展开/上次文件是个人使用偏好）。`load` 只在应用
 * 启动时调用一次（appStore.init），`flush` 直接整写（无合并/无归属校验）。
 *
 * 分层：FileExplorerPanel / ProjectWorkspacePage / WorkspaceGrid 走本 store，
 * 不直调 `services`。持久化 debounce 400ms（同 settingsStore.persistDebounced 模式）。
 */
import { create } from "zustand";
import { readAppUiState, writeAppUiState } from "@/services/uiState";
import { remapDirPrefix } from "@/utils/filename";
import {
  closeArea as closeAreaOp,
  mergeSibling as mergeSiblingOp,
  regenerateIds,
  setAreaView as setAreaViewOp,
  setLayoutSizes as setLayoutSizesOp,
  splitArea as splitAreaOp,
} from "@/utils/workspaceLayout";
import {
  createDefaultLayout,
  type LayoutNode,
  type SplitDirection,
  type ViewKind,
  type WorkspaceLayout,
} from "@/types/workspaceLayout";
import { UI_STATE_SCHEMA, type AppUiState } from "@/types";

interface UiStateStore {
  /** 文件面板展开的文件夹相对路径集合（不可变更新，防 selector 无限重渲染）。 */
  fileExplorerExpanded: Set<string>;
  /** 上次打开的画布文件（相对仓库根；关闭/删除后清空）。 */
  lastCanvasFile: string | null;
  /** 上次打开的笔记文件（相对仓库根；关闭/删除后清空）。 */
  lastNoteFile: string | null;
  /** 上次打开的表格文件（相对仓库根；关闭/删除后清空）。 */
  lastTableFile: string | null;
  /** 工作区布局列表（至少一项；load 前为默认布局）。 */
  workspaceLayouts: WorkspaceLayout[];
  /** 激活布局 id（缺省 = 列表第一个）。 */
  activeLayoutId: string | null;
  /** 聚焦面积 id（画布快捷键门控；面积可能已被关闭/布局切换，渲染兜底聚焦第一个）。 */
  focusedAreaId: string | null;
  /** 当前 ui-state 是否已从磁盘加载（恢复 effect 依赖它避免在加载前误清状态）。 */
  loaded: boolean;

  /** 应用启动时调用一次：读 app_data_dir/ui-state.json 填充运行时态。由 appStore.init 调用。 */
  load: () => Promise<void>;
  /** 文件面板展开/收起文件夹（toggle）。 */
  toggleExpanded: (path: string) => void;
  /** 展开指定文件夹（移动文件到目标后让其可见；已展开的不重复处理）。 */
  expandDirs: (paths: string[]) => void;
  /** 「展开/收起全部」：dirPaths = 当前树全部文件夹路径；全部展开时切换为收起。 */
  toggleExpandAll: (dirPaths: string[]) => void;
  /** 记录打开的画布文件（lastCanvasFile）。 */
  recordOpenCanvas: (file: string) => void;
  /** 记录打开的笔记文件（lastNoteFile）。 */
  recordOpenNote: (file: string) => void;
  /** 记录打开的表格文件（lastTableFile）。 */
  recordOpenTable: (file: string) => void;
  /** 画布重命名/移动后同步 lastCanvasFile（旧路径命中才更新）。 */
  renameLastCanvas: (oldFile: string, newFile: string) => void;
  /** 笔记重命名/移动后同步 lastNoteFile（旧路径命中才更新）。 */
  renameLastNote: (oldFile: string, newFile: string) => void;
  /** 表格重命名/移动后同步 lastTableFile（旧路径命中才更新）。 */
  renameLastTable: (oldFile: string, newFile: string) => void;
  /** 文件夹重命名后同步展开集合/上次打开文件（`oldDir/` 前缀 → `newDir/`）。 */
  renameByDir: (oldDir: string, newDir: string) => void;
  /** 文件夹删除后清理展开集合中该目录及子目录条目。 */
  removeExpandedByDir: (dir: string) => void;
  /** 关闭画布：清空 lastCanvasFile。 */
  closeCanvas: () => void;
  /** 关闭笔记：清空 lastNoteFile。 */
  closeNote: () => void;
  /** 关闭表格：清空 lastTableFile。 */
  closeTable: () => void;
  /** 设置聚焦面积（点击面积时；null = 无聚焦）。 */
  setFocusedArea: (areaId: string | null) => void;
  /** 分割激活布局中的面积（原面积保留 + 新 empty 面积），返回新面积 id。 */
  splitArea: (areaId: string, direction: SplitDirection) => string | null;
  /** 关闭激活布局中的面积（合并到兄弟）；最后一个面积返回 false 不可关。 */
  closeArea: (areaId: string) => boolean;
  /** 边合并：删除 Split 中 keep 对侧的整棵子树（含多个面积），保留侧顶替其位置。 */
  mergeSibling: (splitId: string, keep: 0 | 1) => void;
  /** 切换激活布局中面积承载的视图类型。 */
  setAreaView: (areaId: string, view: ViewKind) => void;
  /** 拖拽调宽回写 Split 子树尺寸比例（百分数，和 = 100）。 */
  setLayoutSizes: (splitId: string, sizes: [number, number]) => void;
  /** 新建布局（复制当前激活布局），命名「布局 N」自动去重，并激活。 */
  addLayout: () => void;
  /** 重命名布局。 */
  renameLayout: (id: string, name: string) => void;
  /** 删除布局（最后一个不可删）。 */
  deleteLayout: (id: string) => void;
  /** 激活布局（切换布局：仅替换面积网格，文件状态不动）。 */
  activateLayout: (id: string) => void;
  /** 调整布局顺序（布局 tab 拖拽排序）。 */
  moveLayout: (fromIndex: number, toIndex: number) => void;
  /** 立即落盘（应用退出/切页面前 flush 用，防 debounce 窗口内丢状态）。 */
  flush: () => Promise<void>;
}

/** 激活布局（activeLayoutId 失效/未设时回退第一个；列表恒非空）。 */
function activeLayout(get: () => UiStateStore): WorkspaceLayout {
  return (
    get().workspaceLayouts.find((l) => l.id === get().activeLayoutId) ??
    get().workspaceLayouts[0]
  );
}

/** 「布局 N」命名自动去重（N = 最小未占用序号）。 */
function nextLayoutName(names: string[]): string {
  let n = 1;
  while (names.includes(`布局 ${n}`)) n++;
  return `布局 ${n}`;
}

// 输入高频（展开/折叠/布局拖拽），debounce 后落盘避免每键一次 IPC
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistDebounced(get: () => UiStateStore): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void get().flush();
  }, 400);
}

/** 内存态 → 磁盘条目（缺省字段不落盘，保持文件精简）。 */
function toDiskState(get: () => UiStateStore): AppUiState {
  const s = get();
  return {
    schema: UI_STATE_SCHEMA,
    fileExplorerExpanded: [...s.fileExplorerExpanded],
    ...(s.lastCanvasFile ? { lastCanvasFile: s.lastCanvasFile } : {}),
    ...(s.lastNoteFile ? { lastNoteFile: s.lastNoteFile } : {}),
    ...(s.lastTableFile ? { lastTableFile: s.lastTableFile } : {}),
    workspaceLayouts: s.workspaceLayouts,
    ...(s.activeLayoutId ? { activeLayoutId: s.activeLayoutId } : {}),
    ...(s.focusedAreaId ? { focusedAreaId: s.focusedAreaId } : {}),
  };
}

export const useUiStateStore = create<UiStateStore>((set, get) => {
  /** 更新激活布局的区域树并落盘（布局操作统一出口）。 */
  const updateActiveLayout = (updater: (tree: LayoutNode) => LayoutNode): void => {
    const layout = activeLayout(get);
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === layout.id ? { ...l, tree: updater(layout.tree) } : l,
      ),
    });
    persistDebounced(get);
  };

  return {
  fileExplorerExpanded: new Set(),
  lastCanvasFile: null,
  lastNoteFile: null,
  lastTableFile: null,
  workspaceLayouts: [createDefaultLayout()],
  activeLayoutId: null,
  focusedAreaId: null,
  loaded: false,

  load: async () => {
    // 清残留 debounce timer：应用启动/重载前旧 timer 不应再写盘
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      const disk = await readAppUiState();
      // 布局恢复：磁盘无/损坏（数组空、项缺 tree 结构）时回退默认布局——
      // 缺校验会让 WorkspaceGrid 收到 undefined tree 白屏
      const layouts =
        Array.isArray(disk.workspaceLayouts) &&
        disk.workspaceLayouts.length > 0 &&
        disk.workspaceLayouts.every(
          (l) => l && (l.tree?.kind === "area" || l.tree?.kind === "split"),
        )
          ? disk.workspaceLayouts
          : [createDefaultLayout()];
      const activeLayoutId =
        disk.activeLayoutId && layouts.some((l) => l.id === disk.activeLayoutId)
          ? disk.activeLayoutId
          : (layouts[0]?.id ?? null);
      set({
        fileExplorerExpanded: new Set(disk.fileExplorerExpanded),
        lastCanvasFile: disk.lastCanvasFile ?? null,
        lastNoteFile: disk.lastNoteFile ?? null,
        lastTableFile: disk.lastTableFile ?? null,
        workspaceLayouts: layouts,
        activeLayoutId,
        focusedAreaId: disk.focusedAreaId ?? null,
        loaded: true,
      });
    } catch (e) {
      console.error("读取应用级 UI 状态失败", e);
      set({
        fileExplorerExpanded: new Set(),
        lastCanvasFile: null,
        lastNoteFile: null,
        lastTableFile: null,
        workspaceLayouts: [createDefaultLayout()],
        activeLayoutId: null,
        focusedAreaId: null,
        loaded: true,
      });
    }
  },

  toggleExpanded: (path) => {
    set((s) => {
      const next = new Set(s.fileExplorerExpanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { fileExplorerExpanded: next };
    });
    persistDebounced(get);
  },

  expandDirs: (paths) => {
    if (paths.length === 0) return;
    set((s) => {
      const next = new Set(s.fileExplorerExpanded);
      for (const p of paths) next.add(p);
      return { fileExplorerExpanded: next };
    });
    persistDebounced(get);
  },

  toggleExpandAll: (dirPaths) => {
    set((s) => {
      const allExpanded = dirPaths.length > 0 && dirPaths.every((p) => s.fileExplorerExpanded.has(p));
      return { fileExplorerExpanded: allExpanded ? new Set() : new Set(dirPaths) };
    });
    persistDebounced(get);
  },

  recordOpenCanvas: (file) => {
    set({ lastCanvasFile: file });
    persistDebounced(get);
  },

  recordOpenNote: (file) => {
    set({ lastNoteFile: file });
    persistDebounced(get);
  },

  recordOpenTable: (file) => {
    set({ lastTableFile: file });
    persistDebounced(get);
  },

  renameLastCanvas: (oldFile, newFile) => {
    if (get().lastCanvasFile !== oldFile) return;
    set({ lastCanvasFile: newFile });
    persistDebounced(get);
  },

  renameLastNote: (oldFile, newFile) => {
    if (get().lastNoteFile !== oldFile) return;
    set({ lastNoteFile: newFile });
    persistDebounced(get);
  },

  renameLastTable: (oldFile, newFile) => {
    if (get().lastTableFile !== oldFile) return;
    set({ lastTableFile: newFile });
    persistDebounced(get);
  },

  renameByDir: (oldDir, newDir) => {
    const s = get();
    let expandedChanged = false;
    const expanded = new Set<string>();
    for (const p of s.fileExplorerExpanded) {
      const next = remapDirPrefix(p, oldDir, newDir);
      if (next !== p) expandedChanged = true;
      expanded.add(next);
    }
    const lastCanvasFile = s.lastCanvasFile
      ? remapDirPrefix(s.lastCanvasFile, oldDir, newDir)
      : null;
    const lastNoteFile = s.lastNoteFile ? remapDirPrefix(s.lastNoteFile, oldDir, newDir) : null;
    const lastTableFile = s.lastTableFile ? remapDirPrefix(s.lastTableFile, oldDir, newDir) : null;
    const changed =
      expandedChanged || lastCanvasFile !== s.lastCanvasFile || lastNoteFile !== s.lastNoteFile || lastTableFile !== s.lastTableFile;
    if (!changed) return;
    set({ fileExplorerExpanded: expanded, lastCanvasFile, lastNoteFile, lastTableFile });
    persistDebounced(get);
  },

  removeExpandedByDir: (dir) => {
    const prefix = `${dir}/`;
    const next = new Set(
      [...get().fileExplorerExpanded].filter((p) => p !== dir && !p.startsWith(prefix)),
    );
    if (next.size === get().fileExplorerExpanded.size) return;
    set({ fileExplorerExpanded: next });
    persistDebounced(get);
  },

  closeCanvas: () => {
    set({ lastCanvasFile: null });
    persistDebounced(get);
  },

  closeNote: () => {
    set({ lastNoteFile: null });
    persistDebounced(get);
  },

  closeTable: () => {
    set({ lastTableFile: null });
    persistDebounced(get);
  },

  setFocusedArea: (areaId) => {
    if (get().focusedAreaId === areaId) return;
    set({ focusedAreaId: areaId });
    persistDebounced(get);
  },

  splitArea: (areaId, direction) => {
    const layout = activeLayout(get);
    const { tree, newAreaId } = splitAreaOp(layout.tree, areaId, direction);
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === layout.id ? { ...l, tree } : l,
      ),
    });
    persistDebounced(get);
    return newAreaId;
  },

  closeArea: (areaId) => {
    const layout = activeLayout(get);
    const tree = closeAreaOp(layout.tree, areaId);
    if (!tree) return false;
    updateActiveLayout(() => tree);
    set({ focusedAreaId: get().focusedAreaId === areaId ? null : get().focusedAreaId });
    return true;
  },

  mergeSibling: (splitId, keep) => {
    updateActiveLayout((tree) => mergeSiblingOp(tree, splitId, keep));
  },

  setAreaView: (areaId, view) => {
    updateActiveLayout((tree) => setAreaViewOp(tree, areaId, view));
  },

  setLayoutSizes: (splitId, sizes) => {
    updateActiveLayout((tree) => setLayoutSizesOp(tree, splitId, sizes));
  },

  addLayout: () => {
    const layout = activeLayout(get);
    const copy: WorkspaceLayout = {
      id: crypto.randomUUID(),
      name: nextLayoutName(get().workspaceLayouts.map((l) => l.name)),
      // 复制树并重新生成全部节点 id：布局复制 = 独立副本（id 全局唯一约定）
      tree: regenerateIds(layout.tree),
    };
    set({
      workspaceLayouts: [...get().workspaceLayouts, copy],
      activeLayoutId: copy.id,
      focusedAreaId: null,
    });
    persistDebounced(get);
  },

  renameLayout: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === id ? { ...l, name: trimmed } : l,
      ),
    });
    persistDebounced(get);
  },

  deleteLayout: (id) => {
    const { workspaceLayouts, activeLayoutId } = get();
    if (workspaceLayouts.length <= 1) return;
    const next = workspaceLayouts.filter((l) => l.id !== id);
    const nextActive = activeLayoutId === id ? (next[0]?.id ?? null) : activeLayoutId;
    set({
      workspaceLayouts: next,
      activeLayoutId: nextActive,
      focusedAreaId: nextActive === activeLayoutId ? get().focusedAreaId : null,
    });
    persistDebounced(get);
  },

  activateLayout: (id) => {
    if (!get().workspaceLayouts.some((l) => l.id === id)) return;
    set({ activeLayoutId: id, focusedAreaId: null });
    persistDebounced(get);
  },

  moveLayout: (fromIndex, toIndex) => {
    const { workspaceLayouts } = get();
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= workspaceLayouts.length || toIndex >= workspaceLayouts.length) return;
    const next = [...workspaceLayouts];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    set({ workspaceLayouts: next });
    persistDebounced(get);
  },

  flush: async () => {
    // 启动竞态守卫：load 未完成前落盘会用默认值覆盖真实磁盘状态
    if (!get().loaded) return;
    // 直接整写（应用级单文件，无合并/归属校验）；无仓库也可写（布局跨仓库共享）
    const payload = toDiskState(get);
    try {
      await writeAppUiState(payload);
    } catch (e) {
      console.error("保存应用级 UI 状态失败", e);
    }
  },
  };
});
