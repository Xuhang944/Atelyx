/**
 * 仓库级 UI 使用状态。
 *
 * 持有跨会话恢复所需的两类「使用数据」，独立落盘 `.atelyx/ui-state.json`
 * （与仓库级配置 config.json 分离，高频展开/折叠写入抖动不进配置）：
 * - 文件面板展开的文件夹集合（进入仓库自动恢复上次展开情况）；
 * - 上次打开的画布/笔记文件 + 激活窗口（设置「自动恢复上次打开的文件」开启时恢复）。
 *
 * **按设备分桶**：仓库可能随 Git/云盘多设备同步，磁盘格式为 `perDevice[设备ID]`
 * （ID 见 `services/global` 的 `getDeviceId`），各设备读写自己的桶互不覆盖。
 * flush 前重读磁盘再合并本设备条目（保留他设备条目），防同步竞争互相覆盖。
 * 旧平铺字段仅在无本设备条目时回退播种（迁移），写入只落分桶。
 *
 * 分层：FileExplorerPanel / ProjectWorkspacePage 走本 store，
 * 不直调 `services/vault`。持久化 debounce 400ms（同 settingsStore.persistDebounced 模式），
 * 写盘前捕获仓库 ID 校验归属，防切换仓库的 async 间隙把 A 仓库状态写进 B 仓库。
 */
import { create } from "zustand";
import { readVaultUiState, writeVaultUiState } from "@/services/vault";
import { getDeviceId } from "@/services/global";
import { useAppStore } from "@/stores/appStore";
import { remapDirPrefix } from "@/utils/filename";
import {
  UI_STATE_SCHEMA,
  type DeviceUiState,
  type LastActiveWindow,
  type VaultUiState,
} from "@/types";

interface UiStateStore {
  /** 文件面板展开的文件夹相对路径集合（不可变更新，防 selector 无限重渲染）。 */
  fileExplorerExpanded: Set<string>;
  /** 上次打开的画布文件（相对仓库根；关闭/删除后清空）。 */
  lastCanvasFile: string | null;
  /** 上次打开的笔记文件（相对仓库根；关闭/删除后清空）。 */
  lastNoteFile: string | null;
  /** 上次打开的表格文件（相对仓库根；关闭/删除后清空）。 */
  lastTableFile: string | null;
  /** 上次激活的窗口（画布 / 笔记 / 表格；null = 画布槽）。 */
  lastActiveWindow: LastActiveWindow | null;
  /** 当前 ui-state 是否已从磁盘加载（恢复 effect 依赖它避免在加载前误清状态）。 */
  loaded: boolean;

  /** 打开仓库后调用：读 .atelyx/ui-state.json 填充运行时态。由 appStore.selectVault 调用。 */
  load: () => Promise<void>;
  /** 切仓库/回启动页时清空内存态（防残留跨仓库写盘）。 */
  clear: () => void;
  /** 文件面板展开/收起文件夹（toggle）。 */
  toggleExpanded: (path: string) => void;
  /** 展开指定文件夹（移动文件到目标后让其可见；已展开的不重复处理）。 */
  expandDirs: (paths: string[]) => void;
  /** 「展开/收起全部」：dirPaths = 当前树全部文件夹路径；全部展开时切换为收起。 */
  toggleExpandAll: (dirPaths: string[]) => void;
  /** 记录打开的画布文件（lastCanvasFile + 激活画布窗口）。 */
  recordOpenCanvas: (file: string) => void;
  /** 记录打开的笔记文件（lastNoteFile + 激活笔记窗口）。 */
  recordOpenNote: (file: string) => void;
  /** 记录打开的表格文件（lastTableFile + 激活表格窗口）。 */
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
  /** 记录窗口切换（激活窗口随标签点击/联动变化）。 */
  recordActiveWindow: (win: LastActiveWindow) => void;
  /** 关闭画布窗口：清空 lastCanvasFile（窗口槽保留占位）。 */
  closeCanvas: () => void;
  /** 关闭笔记窗口：清空 lastNoteFile。 */
  closeNote: () => void;
  /** 关闭表格窗口：清空 lastTableFile。 */
  closeTable: () => void;
  /** 立即落盘（切仓库前 flush 用，防 debounce 窗口内丢状态）。 */
  flush: () => Promise<void>;
}

/** 当前仓库稳定 ID（写盘归属校验用；设置/恢复入口只在工作区，必有当前仓库）。 */
function currentVaultId(): string {
  return useAppStore.getState().vaultId ?? "";
}

// 输入高频（展开/折叠/窗口切换），debounce 后落盘避免每键一次 IPC
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistDebounced(get: () => UiStateStore): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void get().flush();
  }, 400);
}

/** 旧平铺磁盘格式 → 设备条目（迁移回退；新写入只写 perDevice 分桶）。 */
function legacyToDeviceState(disk: VaultUiState): DeviceUiState {
  return {
    fileExplorerExpanded: disk.fileExplorerExpanded ?? [],
    ...(disk.lastCanvasFile ? { lastCanvasFile: disk.lastCanvasFile } : {}),
    ...(disk.lastNoteFile ? { lastNoteFile: disk.lastNoteFile } : {}),
    ...(disk.lastTableFile ? { lastTableFile: disk.lastTableFile } : {}),
    ...(disk.lastActiveWindow ? { lastActiveWindow: disk.lastActiveWindow } : {}),
  };
}

/** 内存态 → 本设备的磁盘条目。 */
function toDeviceState(get: () => UiStateStore): DeviceUiState {
  const s = get();
  return {
    fileExplorerExpanded: [...s.fileExplorerExpanded],
    ...(s.lastCanvasFile ? { lastCanvasFile: s.lastCanvasFile } : {}),
    ...(s.lastNoteFile ? { lastNoteFile: s.lastNoteFile } : {}),
    ...(s.lastTableFile ? { lastTableFile: s.lastTableFile } : {}),
    ...(s.lastActiveWindow ? { lastActiveWindow: s.lastActiveWindow } : {}),
  };
}

export const useUiStateStore = create<UiStateStore>((set, get) => ({
  fileExplorerExpanded: new Set(),
  lastCanvasFile: null,
  lastNoteFile: null,
  lastTableFile: null,
  lastActiveWindow: null,
  loaded: false,

  load: async () => {
    // 清残留 debounce timer：切仓库后旧 timer 触发会用新仓库 ID 写旧内存态（防跨仓库写串）
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // 切仓库竞态守卫：后台填充链与 VaultSwitcher 快速切换并发时，旧仓库读取结果不得覆盖新仓库内存态
    const vaultId = currentVaultId();
    try {
      const [deviceId, disk] = await Promise.all([getDeviceId(), readVaultUiState()]);
      if (currentVaultId() !== vaultId) return;
      // 本设备无条目时回退旧平铺字段（首次升级迁移；旧文件只写了平铺字段）
      const mine = disk.perDevice?.[deviceId] ?? legacyToDeviceState(disk);
      set({
        fileExplorerExpanded: new Set(mine.fileExplorerExpanded),
        lastCanvasFile: mine.lastCanvasFile ?? null,
        lastNoteFile: mine.lastNoteFile ?? null,
        lastTableFile: mine.lastTableFile ?? null,
        lastActiveWindow: mine.lastActiveWindow ?? null,
        loaded: true,
      });
    } catch (e) {
      console.error("读取仓库 UI 状态失败", e);
      if (currentVaultId() !== vaultId) return;
      set({ fileExplorerExpanded: new Set(), lastCanvasFile: null, lastNoteFile: null, lastTableFile: null, lastActiveWindow: null, loaded: true });
    }
  },

  clear: () => {
    // 清残留 debounce timer：clear 语义 = 本仓库内存态不再可用，后续不得再落盘
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    set({
      fileExplorerExpanded: new Set(),
      lastCanvasFile: null,
      lastNoteFile: null,
      lastTableFile: null,
      lastActiveWindow: null,
      loaded: false,
    });
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
    set({ lastCanvasFile: file, lastActiveWindow: "canvas" });
    persistDebounced(get);
  },

  recordOpenNote: (file) => {
    set({ lastNoteFile: file, lastActiveWindow: "note" });
    persistDebounced(get);
  },

  recordOpenTable: (file) => {
    set({ lastTableFile: file, lastActiveWindow: "table" });
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

  recordActiveWindow: (win) => {
    set({ lastActiveWindow: win });
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

  flush: async () => {
    // 归属校验 + 脏检测：无仓库（回启动页）不写盘；防 A 仓库状态写进 B 仓库 config 同款竞态
    const vaultId = currentVaultId();
    if (!vaultId) return;
    // 快照 payload：此刻内存态即本仓库状态，await 期间不随内存变化
    const payload = toDeviceState(get);
    try {
      const deviceId = await getDeviceId();
      // 写前重读磁盘再合并本设备条目：仓库多设备同步时保留他设备条目，防互相覆盖
      const disk = await readVaultUiState();
      // await 后再次校验归属：期间若已切仓库（回启动页后快速打开新仓库），Rust 侧写盘
      // 目标 root 已换新仓库，继续写会把旧仓库状态串进新仓库
      if (currentVaultId() !== vaultId) return;
      const perDevice = { ...disk.perDevice };
      perDevice[deviceId] = payload;
      await writeVaultUiState({ schema: UI_STATE_SCHEMA, perDevice });
    } catch (e) {
      console.error("保存仓库 UI 状态失败", e);
    }
  },
}));
