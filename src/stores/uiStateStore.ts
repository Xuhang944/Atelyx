/**
 * 应用级 UI 使用状态。
 *
 * 持有跨会话恢复所需的使用数据，独立落盘 `app_data_dir/ui-state.json`
 * （与全局配置 global.json 分离，高频展开/折叠/布局拖拽写入抖动不进配置）：
 * - 工作区布局（布局列表 + 激活布局 + 聚焦面积，见 `types/workspaceLayout.ts`）；
 * - 撕裂窗口（应用级 `detachedWindows`：视图 + 位置尺寸，跨布局共享，重启恢复）；
 * - 上次打开的画布/笔记/表格文件（设置「自动恢复上次打开的文件」开启时恢复）；
 * - 文件面板展开的文件夹集合（进入仓库自动恢复上次展开情况）。
 *
 * **应用级、跨仓库共享**：app_data_dir 本机独有、不随仓库同步，无需按设备分桶；
 * 切仓库不清空、不重载（布局/展开/上次文件是个人使用偏好）。`load` 只在应用
 * 启动时调用一次（appStore.init），`flush` 直接整写（无合并/无归属校验）。
 *
 * **布局权威在主窗口**：全部布局操作（标签激活/关闭/锁定/排序/撕裂/停靠/分割/删除面积）
 * 在本 store 应用并持久化；撕裂窗口只发操作请求、经 `layout-changed` 广播同步。
 * 视图跨窗口交接的编排（flush/clear/load + OS 窗口生命周期）在 `stores/panelStore.ts`。
 *
 * 分层：FileExplorerPanel / ProjectWorkspacePage / WorkspaceGrid / panelStore 走本 store，
 * 不直调 `services`。持久化 debounce 400ms（同 settingsStore.persistDebounced 模式）。
 */
import { create } from "zustand";
import { readAppUiState, writeAppUiState } from "@/services/uiState";
import { remapDirPrefix } from "@/utils/filename";
import { createPersistController } from "@/utils/persist";
import {
  addTabToArea as addTabToAreaOp,
  closeArea as closeAreaOp,
  collectViewsInTree as collectViewsInTreeOp,
  detachedAddTab as detachedAddTabOp,
  detachedMoveTab as detachedMoveTabOp,
  detachedRemoveTab as detachedRemoveTabOp,
  detachedSetActive as detachedSetActiveOp,
  detachedSetBounds as detachedSetBoundsOp,
  detachedSetLocked as detachedSetLockedOp,
  findArea,
  findTabInDetached,
  findTabInTree,
  migrateLegacyTree,
  moveTabWithinArea as moveTabWithinAreaOp,
  regenerateIds,
  removeTabFromArea as removeTabFromAreaOp,
  setActiveTab as setActiveTabOp,
  setLayoutSizes as setLayoutSizesOp,
  setTabLocked as setTabLockedOp,
  splitArea as splitAreaOp,
  tearOffFromArea,
} from "@/utils/workspaceLayout";
import {
  createDefaultLayouts,
  createTab,
  type DetachedWindow,
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
  /** 撕裂出去的独立窗口（应用级、跨布局共享；视图全局唯一约束覆盖树 + 此列表）。 */
  detachedWindows: DetachedWindow[];
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

  /** 添加视图到面积（下拉入口）：组内已有该视图 = 激活；否则新建标签并激活。 */
  addViewToArea: (areaId: string, view: ViewKind) => void;
  /** 激活面积中的标签。 */
  setActiveTab: (areaId: string, tabId: string) => void;
  /** 关闭面积中的标签（≡ 菜单）：锁定标签拒关；最后一个标签关闭 → 面积留空。 */
  closeTab: (areaId: string, tabId: string) => void;
  /** 锁定/解锁面积中的标签（锁定 = 固定：禁拖/禁撕裂/禁关闭）。 */
  setTabLocked: (areaId: string, tabId: string, locked: boolean) => void;
  /** 面积标签组内排序。 */
  moveTabWithinArea: (areaId: string, tabId: string, toIndex: number) => void;
  /** 窗口内跨面积移动标签（面积 A → 面积 B 标签组，默认尾部）。 */
  moveTabBetweenAreas: (fromAreaId: string, toAreaId: string, tabId: string, index?: number) => void;
  /** 分割激活布局中的面积：父 split 方向匹配时同级插入新空面积（多叉），否则嵌套回退。返回新面积 id。 */
  splitArea: (
    areaId: string,
    direction: SplitDirection,
    position?: "before" | "after",
  ) => string | null;
  /** 删除面积 = 合并到父 Split 兄弟（空面积「删除面积」入口）；最后一个面积不可删。 */
  closeArea: (areaId: string) => boolean;
  /** 撕裂标签：从面积移除（面积留空）→ 挂到应用级 detachedWindows，返回新窗口条目。 */
  tearOffTab: (
    areaId: string,
    tabId: string,
    bounds: DetachedWindow["bounds"],
  ) => DetachedWindow | null;
  /** 撕裂窗口再撕裂：把标签从撕裂窗口移到新的撕裂窗口条目（源窗口拖空后由调用方回收）。 */
  tearOffFromDetached: (
    windowId: string,
    tabId: string,
    bounds: DetachedWindow["bounds"],
  ) => DetachedWindow | null;
  /** 拖回：把撕裂窗口中的标签停靠进主窗口面积（默认尾部并激活；源窗口拖空自动移除）。 */
  dockTabIntoArea: (areaId: string, tabId: string, index?: number) => void;
  /** 拖入：把标签停靠进撕裂窗口（来源 = 树面积或另一撕裂窗口；同窗口 = 组内排序）。 */
  dockTabIntoDetached: (windowId: string, tabId: string, index?: number) => void;
  /** 向撕裂窗口添加新视图标签（视图全局唯一，已占用则忽略；面板窗口「添加视图」入口）。 */
  detachedAddView: (windowId: string, view: ViewKind) => void;
  /** 激活撕裂窗口中的标签。 */
  detachedSetActive: (windowId: string, tabId: string) => void;
  /** 关闭撕裂窗口中的标签（锁定拒关；拖空后窗口条目移除，OS 窗口关闭由 panelStore 处理）。 */
  detachedCloseTab: (windowId: string, tabId: string) => void;
  /** 锁定/解锁撕裂窗口中的标签。 */
  detachedSetLocked: (windowId: string, tabId: string, locked: boolean) => void;
  /** 撕裂窗口标签组内排序。 */
  detachedMoveTab: (windowId: string, tabId: string, toIndex: number) => void;
  /** 更新撕裂窗口位置尺寸（面板窗口移动/缩放后上报，防抖落盘）。 */
  detachedSetBounds: (windowId: string, bounds: DetachedWindow["bounds"]) => void;
  /** 移除撕裂窗口条目（OS 窗口已关闭/拖空自动关窗时调用）。 */
  removeDetachedWindow: (windowId: string) => void;
  /** 拖拽调宽回写 Split 子树尺寸比例（百分数，和 = 100，长度 = children 长度）。 */
  setLayoutSizes: (splitId: string, sizes: number[]) => void;
  /** 新建布局（复制当前激活布局），命名「布局 N」自动去重，并激活。 */
  addLayout: () => void;
  /** 重命名布局。 */
  renameLayout: (id: string, name: string) => void;
  /** 删除布局（最后一个不可删）。 */
  deleteLayout: (id: string) => void;
  /** 激活布局（切换布局：仅替换面积网格，文件状态与撕裂窗口不动）。 */
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

/** 撕裂窗口条目合法性校验（load 时过滤损坏条目）。 */
function isValidDetached(w: DetachedWindow): boolean {
  return !!w && typeof w.id === "string" && Array.isArray(w.tabs) && !!w.bounds;
}

/** 移除被拖空/关空的撕裂窗口条目（标签全走后窗口无意义，自动回收）。 */
function pruneEmptyWindows(windows: DetachedWindow[]): DetachedWindow[] {
  return windows.filter((w) => w.tabs.length > 0);
}

// 输入高频（展开/折叠/布局拖拽），debounce 后落盘避免每键一次 IPC
/** 撕裂窗口持久化抑制：面板窗口（label panel-*）的 uiStateStore 实例不落盘——
 * 防其默认态（未 load）整写覆盖主窗口的 ui-state.json。由 panelStore.initPanel 设置。 */
let persistSuppressed = false;
export function setUiStatePersistSuppressed(suppressed: boolean): void {
  persistSuppressed = suppressed;
}

/** 防抖持久化控制器：timer 管理统一在此（400ms；写盘含 loaded 竞态守卫）。 */
const persistCtl = createPersistController({
  persist: async () => {
    // 启动竞态守卫：load 未完成前落盘会用默认值覆盖真实磁盘状态
    const s = useUiStateStore.getState();
    if (!s.loaded) return;
    try {
      await writeAppUiState(toDiskState(() => useUiStateStore.getState()));
    } catch (e) {
      console.error("保存应用级 UI 状态失败", e);
    }
  },
  delay: 400,
});

function persistDebounced(): void {
  if (persistSuppressed) return;
  persistCtl.schedule();
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
    ...(s.detachedWindows.length > 0 ? { detachedWindows: s.detachedWindows } : {}),
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
    persistDebounced();
  };

  /** 同时更新激活布局树与撕裂窗口列表（撕裂/停靠等跨宿主操作统一出口）。 */
  const updateLayoutAndDetached = (
    treeUpdater: (tree: LayoutNode) => LayoutNode,
    detachedUpdater: (windows: DetachedWindow[]) => DetachedWindow[],
  ): void => {
    const layout = activeLayout(get);
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === layout.id ? { ...l, tree: treeUpdater(layout.tree) } : l,
      ),
      detachedWindows: detachedUpdater(get().detachedWindows),
    });
    persistDebounced();
  };

  /** 仅更新撕裂窗口列表（撕裂窗口内操作统一出口）。 */
  const updateDetachedWindows = (updater: (windows: DetachedWindow[]) => DetachedWindow[]): void => {
    set({ detachedWindows: updater(get().detachedWindows) });
    persistDebounced();
  };

  return {
  fileExplorerExpanded: new Set(),
  lastCanvasFile: null,
  lastNoteFile: null,
  lastTableFile: null,
  workspaceLayouts: createDefaultLayouts(),
  activeLayoutId: null,
  focusedAreaId: null,
  detachedWindows: [],
  loaded: false,

  load: async () => {
    // 清残留 debounce timer：应用启动/重载前旧 timer 不应再写盘
    persistCtl.cancel();
    try {
      const disk = await readAppUiState();
      // 布局恢复：磁盘无/损坏（数组空、项缺 tree 结构）时回退默认布局——
      // 缺校验会让 WorkspaceGrid 收到 undefined tree 白屏；旧 schema（面积含 view 字段）迁移为标签组
      const layouts =
        Array.isArray(disk.workspaceLayouts) &&
        disk.workspaceLayouts.length > 0 &&
        disk.workspaceLayouts.every(
          (l) => l && (l.tree?.kind === "area" || l.tree?.kind === "split"),
        )
          ? disk.workspaceLayouts.map((l) => ({ ...l, tree: migrateLegacyTree(l.tree) }))
          : createDefaultLayouts();
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
        detachedWindows: Array.isArray(disk.detachedWindows)
          ? disk.detachedWindows.filter(isValidDetached)
          : [],
        loaded: true,
      });
    } catch (e) {
      console.error("读取应用级 UI 状态失败", e);
      set({
        fileExplorerExpanded: new Set(),
        lastCanvasFile: null,
        lastNoteFile: null,
        lastTableFile: null,
        workspaceLayouts: createDefaultLayouts(),
        activeLayoutId: null,
        focusedAreaId: null,
        detachedWindows: [],
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
    persistDebounced();
  },

  expandDirs: (paths) => {
    if (paths.length === 0) return;
    set((s) => {
      const next = new Set(s.fileExplorerExpanded);
      for (const p of paths) next.add(p);
      return { fileExplorerExpanded: next };
    });
    persistDebounced();
  },

  toggleExpandAll: (dirPaths) => {
    set((s) => {
      const allExpanded = dirPaths.length > 0 && dirPaths.every((p) => s.fileExplorerExpanded.has(p));
      return { fileExplorerExpanded: allExpanded ? new Set() : new Set(dirPaths) };
    });
    persistDebounced();
  },

  recordOpenCanvas: (file) => {
    set({ lastCanvasFile: file });
    persistDebounced();
  },

  recordOpenNote: (file) => {
    set({ lastNoteFile: file });
    persistDebounced();
  },

  recordOpenTable: (file) => {
    set({ lastTableFile: file });
    persistDebounced();
  },

  renameLastCanvas: (oldFile, newFile) => {
    if (get().lastCanvasFile !== oldFile) return;
    set({ lastCanvasFile: newFile });
    persistDebounced();
  },

  renameLastNote: (oldFile, newFile) => {
    if (get().lastNoteFile !== oldFile) return;
    set({ lastNoteFile: newFile });
    persistDebounced();
  },

  renameLastTable: (oldFile, newFile) => {
    if (get().lastTableFile !== oldFile) return;
    set({ lastTableFile: newFile });
    persistDebounced();
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
    persistDebounced();
  },

  removeExpandedByDir: (dir) => {
    const prefix = `${dir}/`;
    const next = new Set(
      [...get().fileExplorerExpanded].filter((p) => p !== dir && !p.startsWith(prefix)),
    );
    if (next.size === get().fileExplorerExpanded.size) return;
    set({ fileExplorerExpanded: next });
    persistDebounced();
  },

  closeCanvas: () => {
    set({ lastCanvasFile: null });
    persistDebounced();
  },

  closeNote: () => {
    set({ lastNoteFile: null });
    persistDebounced();
  },

  closeTable: () => {
    set({ lastTableFile: null });
    persistDebounced();
  },

  setFocusedArea: (areaId) => {
    if (get().focusedAreaId === areaId) return;
    set({ focusedAreaId: areaId });
    persistDebounced();
  },

  addViewToArea: (areaId, view) => {
    const layout = activeLayout(get);
    const area = findArea(layout.tree, areaId);
    if (!area) return;
    const existing = area.tabs.find((t) => t.view === view);
    if (existing) {
      updateActiveLayout((tree) => setActiveTabOp(tree, areaId, existing.id));
      return;
    }
    updateActiveLayout((tree) => addTabToAreaOp(tree, areaId, createTab(view)));
  },

  setActiveTab: (areaId, tabId) => {
    updateActiveLayout((tree) => setActiveTabOp(tree, areaId, tabId));
  },

  closeTab: (areaId, tabId) => {
    const area = findArea(activeLayout(get).tree, areaId);
    const tab = area?.tabs.find((t) => t.id === tabId);
    if (!tab || tab.locked) return;
    updateActiveLayout((tree) => removeTabFromAreaOp(tree, areaId, tabId));
  },

  setTabLocked: (areaId, tabId, locked) => {
    updateActiveLayout((tree) => setTabLockedOp(tree, areaId, tabId, locked));
  },

  moveTabWithinArea: (areaId, tabId, toIndex) => {
    updateActiveLayout((tree) => moveTabWithinAreaOp(tree, areaId, tabId, toIndex));
  },

  moveTabBetweenAreas: (fromAreaId, toAreaId, tabId, index) => {
    const hit = findTabInTree(activeLayout(get).tree, tabId);
    if (!hit || hit.area.id !== fromAreaId) return;
    updateActiveLayout((tree) =>
      addTabToAreaOp(removeTabFromAreaOp(tree, fromAreaId, tabId), toAreaId, hit.tab, index),
    );
  },

  splitArea: (areaId, direction, position = "after") => {
    const layout = activeLayout(get);
    const { tree, newAreaId } = splitAreaOp(layout.tree, areaId, direction, position);
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === layout.id ? { ...l, tree } : l,
      ),
    });
    persistDebounced();
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

  tearOffTab: (areaId, tabId, bounds) => {
    const layout = activeLayout(get);
    const hit = tearOffFromArea(layout.tree, areaId, tabId);
    if (!hit) return null;
    const win: DetachedWindow = {
      id: crypto.randomUUID(),
      tabs: [hit.tab],
      activeTabId: hit.tab.id,
      bounds,
    };
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === layout.id ? { ...l, tree: hit.tree } : l,
      ),
      detachedWindows: [...get().detachedWindows, win],
    });
    persistDebounced();
    return win;
  },

  tearOffFromDetached: (windowId, tabId, bounds) => {
    const hit = findTabInDetached(get().detachedWindows, tabId);
    if (!hit || hit.window.id !== windowId) return null;
    const win: DetachedWindow = {
      id: crypto.randomUUID(),
      tabs: [hit.tab],
      activeTabId: hit.tab.id,
      bounds,
    };
    set({
      detachedWindows: [
        ...pruneEmptyWindows(detachedRemoveTabOp(get().detachedWindows, windowId, tabId)),
        win,
      ],
    });
    persistDebounced();
    return win;
  },

  dockTabIntoArea: (areaId, tabId, index) => {
    const hit = findTabInDetached(get().detachedWindows, tabId);
    if (!hit) return;
    updateLayoutAndDetached(
      (tree) => addTabToAreaOp(tree, areaId, hit.tab, index),
      (windows) => pruneEmptyWindows(detachedRemoveTabOp(windows, hit.window.id, tabId)),
    );
  },

  dockTabIntoDetached: (windowId, tabId, index) => {
    // 同窗口 = 组内排序
    const sameWindow = get().detachedWindows.find((w) => w.id === windowId);
    if (sameWindow?.tabs.some((t) => t.id === tabId)) {
      updateDetachedWindows((windows) =>
        detachedMoveTabOp(windows, windowId, tabId, index ?? windows.find((w) => w.id === windowId)?.tabs.length ?? 0),
      );
      return;
    }
    // 来源 = 树面积
    const inTree = findTabInTree(activeLayout(get).tree, tabId);
    if (inTree) {
      updateLayoutAndDetached(
        (tree) => removeTabFromAreaOp(tree, inTree.area.id, tabId),
        (windows) => detachedAddTabOp(windows, windowId, inTree.tab, index),
      );
      return;
    }
    // 来源 = 另一撕裂窗口
    const inDetached = findTabInDetached(get().detachedWindows, tabId);
    if (inDetached) {
      updateDetachedWindows((windows) =>
        detachedAddTabOp(
          pruneEmptyWindows(detachedRemoveTabOp(windows, inDetached.window.id, tabId)),
          windowId,
          inDetached.tab,
          index,
        ),
      );
    }
  },

  detachedAddView: (windowId, view) => {
    const layout = activeLayout(get);
    const occupied = [
      ...collectViewsInTreeOp(layout.tree),
      ...get().detachedWindows.flatMap((w) => w.tabs.map((t) => t.view)),
    ];
    if (occupied.includes(view)) return;
    updateDetachedWindows((windows) => detachedAddTabOp(windows, windowId, createTab(view)));
  },

  detachedSetActive: (windowId, tabId) => {
    updateDetachedWindows((windows) => detachedSetActiveOp(windows, windowId, tabId));
  },

  detachedCloseTab: (windowId, tabId) => {
    const win = get().detachedWindows.find((w) => w.id === windowId);
    const tab = win?.tabs.find((t) => t.id === tabId);
    if (!tab || tab.locked) return;
    updateDetachedWindows((windows) =>
      pruneEmptyWindows(detachedRemoveTabOp(windows, windowId, tabId)),
    );
  },

  detachedSetLocked: (windowId, tabId, locked) => {
    updateDetachedWindows((windows) => detachedSetLockedOp(windows, windowId, tabId, locked));
  },

  detachedMoveTab: (windowId, tabId, toIndex) => {
    updateDetachedWindows((windows) => detachedMoveTabOp(windows, windowId, tabId, toIndex));
  },

  detachedSetBounds: (windowId, bounds) => {
    updateDetachedWindows((windows) => detachedSetBoundsOp(windows, windowId, bounds));
  },

  removeDetachedWindow: (windowId) => {
    if (!get().detachedWindows.some((w) => w.id === windowId)) return;
    set({ detachedWindows: get().detachedWindows.filter((w) => w.id !== windowId) });
    persistDebounced();
  },

  setLayoutSizes: (splitId, sizes) => {
    updateActiveLayout((tree) => setLayoutSizesOp(tree, splitId, sizes));
  },

  addLayout: () => {
    const layout = activeLayout(get);
    const copy: WorkspaceLayout = {
      id: crypto.randomUUID(),
      name: nextLayoutName(get().workspaceLayouts.map((l) => l.name)),
      // 复制树并重新生成全部节点与标签 id：布局复制 = 独立副本（id 全局唯一约定）
      tree: regenerateIds(layout.tree),
    };
    set({
      workspaceLayouts: [...get().workspaceLayouts, copy],
      activeLayoutId: copy.id,
      focusedAreaId: null,
    });
    persistDebounced();
  },

  renameLayout: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set({
      workspaceLayouts: get().workspaceLayouts.map((l) =>
        l.id === id ? { ...l, name: trimmed } : l,
      ),
    });
    persistDebounced();
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
    persistDebounced();
  },

  activateLayout: (id) => {
    if (!get().workspaceLayouts.some((l) => l.id === id)) return;
    set({ activeLayoutId: id, focusedAreaId: null });
    persistDebounced();
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
    persistDebounced();
  },

  flush: async () => {
    if (persistSuppressed) return;
    await persistCtl.flush();
  },
  };
});
