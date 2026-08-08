import { create } from "zustand";
import {
  listCanvasesVault,
  createCanvasVault,
  deleteCanvasVault,
  renameCanvasVault,
  moveCanvasVault,
  ensureDefaultVault,
  openVault,
  convertWhiteboardToAtlx,
} from "@/services/vault";
import {
  readGlobalConfig,
  updateGlobalConfig,
  bumpRecentVault,
  removeRecentVault as dropVaultFromRecents,
} from "@/services/global";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useChatPanelStore } from "@/stores/chatPanelStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { markSelfSave, useCanvasStore } from "@/stores/canvasStore";
import { dedupeFilename, parentDir, sanitizeFilename, siblingPath } from "@/utils/filename";
import { getAppVersion as getVersionSvc } from "@/services/app";
import { openInExplorer as openInExplorerSvc, openUrl as openUrlSvc } from "@/services/shell";
import { pickDirectory as pickDirectorySvc } from "@/services/dialog";
import { applyStartupWindow as applyStartupWindowSvc, applyWorkspaceWindow as applyWorkspaceWindowSvc, closeWindow as closeWindowSvc, minimizeWindow as minimizeWindowSvc, toggleFullscreen as toggleFullscreenSvc, toggleMaximizeWindow as toggleMaximizeWindowSvc } from "@/services/window";
import { checkForUpdate as checkForUpdateSvc, installUpdate as installUpdateSvc } from "@/services/updater";
import type { CanvasFileRow, RecentVault } from "@/types";

/** 手动检查更新状态（设置页「关于」tab 用）。 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "error";

/**
 * 应用级状态：路由 + 当前仓库 + 画布列表 CRUD。
 *
 * 两视图路由：
 * - vaultSelect：启动页 = 仓库选择，展示最近仓库，打开/新建仓库
 * - workspace：画布工作区（左文件面板 + 右画布；无当前画布时占位引导）
 *
 * 选仓库后直达 workspace（currentCanvasId=null 占位），画布管理收进左栏文件面板。
 * 首启无最近仓库时 ensureDefaultVault 建默认仓库并登记。
 */
type View = "vaultSelect" | "workspace";

interface AppState {
  view: View;
  /** 当前仓库根路径（workspace 期间有效） */
  vaultRoot: string | null;
  /** 当前仓库名（显示用） */
  vaultName: string;
  /** 当前仓库稳定 ID（`.atelyx/config.json` 的 vaultId；chatPanelStore 等据此识别仓库归属）。 */
  vaultId: string | null;
  /** 最近打开的仓库列表（按最近打开倒序） */
  recentVaults: RecentVault[];
  currentCanvasId: string | null;
  /** 当前画布磁盘路径（相对仓库根；打开/保存/重命名/删除按此路径）。 */
  currentCanvasFile: string | null;
  /** 已打开画布标签（顺序 = tab 栏顺序） */
  openTabs: string[];
  canvases: CanvasFileRow[];
  /** 自动检查更新（应用级，存 global.json；缺省 false = 关闭，关闭时完全不联网检查）。 */
  autoUpdate: boolean;
  /** 手动检查更新状态（设置页「关于」tab；运行期状态不持久化）。 */
  updateStatus: UpdateStatus;
  /** 检查到的新版本号（status = available 时有效）。 */
  updateLatestVersion: string;
  /** 检查/安装失败信息（status = error 时有效）。 */
  updateError: string;
  /** 新版本下载安装中（available 后点「下载并安装」）。 */
  installing: boolean;

  /** 应用挂载时调用一次：加载最近仓库，首启建默认仓库。返回本次应自动进入的仓库 root（null = 不自动进入）。 */
  init: () => Promise<string | null>;
  /** 设自动检查更新（应用级，写 global.json；不随仓库同步）。 */
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  /** 手动检查新版本（设置页「关于」）；结果写入 updateStatus/updateLatestVersion/updateError。 */
  checkForUpdates: () => Promise<void>;
  /** 下载并安装已发现的新版本；成功后 relaunch 重启。 */
  installUpdate: () => Promise<void>;
  /** 打开仓库：openVault + 登记最近 + 进画布工作区（占位态）。成功返回 true。 */
  selectVault: (root: string) => Promise<boolean>;
  /** 从最近列表移除某仓库（不删文件）。 */
  removeRecentVault: (root: string) => Promise<void>;
  /** 返回仓库选择页（VaultSwitcher「管理仓库」入口）。 */
  backToVaultSelect: () => void;

  /** 调系统目录选择器，选中路径（用户取消返回 null）。 */
  pickVaultDirectory: () => Promise<string | null>;
  /** 在系统文件管理器中打开路径。 */
  openInExplorer: (path: string) => Promise<void>;
  /** 用系统默认程序打开外部 URL（webview 不导航）。 */
  openUrl: (url: string) => Promise<void>;
  /** 应用版本号（启动页展示用）。 */
  getAppVersion: () => Promise<string>;
  /** 窗口控制（自定义标题栏按钮/全屏）：全部经 services 层转发。 */
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  /** 窗口形态切换（view effect 用）：启动页固定 960×640 不可调整 / 工作区恢复可调整。 */
  applyStartupWindow: () => Promise<void>;
  applyWorkspaceWindow: () => Promise<void>;

  loadList: () => Promise<void>;
  /** 打开画布（树行携带 id + file）。 */
  openCanvas: (row: CanvasFileRow) => void;
  /** 关闭当前画布文件（窗口标签保留为占位槽）：仅清 currentCanvasId，openTabs 保留便于重新打开。 */
  closeCanvasFile: () => void;
  /** 新建画布到 dir（相对仓库根，空 = 根目录），返回 { id, file, title }（title 可能被同名去重）。 */
  createCanvas: (title?: string, dir?: string) => Promise<{ id: string | null; file: string | null; title: string }>;
  /** 重命名画布（同目录改文件名，按当前 file），返回实际标题。 */
  renameCanvas: (row: CanvasFileRow, title: string) => Promise<string>;
  /** 移动画布文件到目标文件夹（保持文件名，目标同名自动加序号；同目录 no-op），返回实际 file。 */
  moveCanvas: (row: CanvasFileRow, targetDir: string) => Promise<string>;
  /** 删除画布（按 file）。 */
  deleteCanvas: (row: CanvasFileRow) => Promise<void>;
  /**
   * 把外部白板文件（.canvas）转换为同目录 .atlx 画布（原文件保留，单向转换）。
   * 成功后刷新画布列表与文件树，返回画布行（页面层打开）；失败返回 null。
   */
  convertWhiteboard: (file: string) => Promise<CanvasFileRow | null>;
}

export const useAppStore = create<AppState>((set, get) => ({
  view: "vaultSelect",
  vaultRoot: null,
  vaultName: "",
  vaultId: null,
  recentVaults: [],
  currentCanvasId: null,
  currentCanvasFile: null,
  openTabs: [],
  canvases: [],
  autoUpdate: false,
  updateStatus: "idle",
  updateLatestVersion: "",
  updateError: "",
  installing: false,

  init: async (): Promise<string | null> => {
    let recents: RecentVault[] = [];
    let autoEnterRoot: string | null = null;
    let autoUpdate = false;
    try {
      const cfg = await readGlobalConfig();
      recents = cfg.recentVaults;
      autoUpdate = cfg.autoUpdate ?? false;
    } catch (e) {
      console.error("读取全局配置失败", e);
    }
    if (recents.length === 0) {
      // 首启无最近仓库 → ensureDefaultVault 建默认仓库（+ 旧 SQLite 迁移）并登记；
      // 本次不自动进入，展示启动页让用户选择/新建仓库
      try {
        const info = await ensureDefaultVault();
        const now = Math.floor(Date.now() / 1000);
        recents = bumpRecentVault(recents, info, now);
        await updateGlobalConfig({ recentVaults: recents });
      } catch (e) {
        console.error("初始化默认仓库失败", e);
      }
    } else {
      // 非首启：recentVaults[0] = 最近打开（selectVault 时置顶）= 上次所在仓库，
      // 启动时跳过启动页直接进入；仓库路径失效时 selectVault 失败自动回退启动页
      autoEnterRoot = recents[0].root;
    }
    set({
      recentVaults: recents,
      view: "vaultSelect",
      openTabs: [],
      autoUpdate: autoUpdate,
    });
    return autoEnterRoot;
  },

  setAutoUpdate: async (enabled) => {
    set({ autoUpdate: enabled });
    try {
      await updateGlobalConfig({ autoUpdate: enabled });
    } catch (e) {
      console.error("保存自动更新配置失败", e);
    }
  },

  checkForUpdates: async () => {
    set({ updateStatus: "checking", updateError: "" });
    try {
      const result = await checkForUpdateSvc();
      set(
        result
          ? {
              updateStatus: "available",
              updateLatestVersion: result.latestVersion,
            }
          : { updateStatus: "upToDate", updateLatestVersion: "" },
      );
    } catch (e) {
      console.error("检查更新失败", e);
      set({
        updateStatus: "error",
        updateError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  installUpdate: async () => {
    set({ installing: true, updateError: "" });
    try {
      await installUpdateSvc();
    } catch (e) {
      console.error("安装更新失败", e);
      set({
        installing: false,
        updateStatus: "error",
        updateError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  selectVault: async (root) => {
    try {
      // 切换前先落盘旧仓库的 AI 对话会话并**等待写盘完成**：openVault 会把 VaultState.root 切到新仓库，
      // 若 fire-and-forget 直接放行，写盘可能晚于 open_vault 执行、把旧会话写进新仓库（跨仓库污染）；
      // 传当前仓库 vaultId 做归属校验 + 脏检测：无改动（如外部删除会话文件）则不写回
      await useChatPanelStore.getState().flush(get().vaultId);
      // 同理落盘旧仓库的 UI 使用状态（展开/上次打开文件），防切仓库后旧内存态串写
      await useUiStateStore.getState().flush();
      const info = await openVault(root);
      const now = Math.floor(Date.now() / 1000);
      const recents = bumpRecentVault(get().recentVaults, info, now);
      // 登记最近仓库失败不阻塞切换：global.json 写入异常（权限/磁盘）只影响最近列表，
      // 若放行抛错会被下方 catch 吞掉，导致后续重载（配置/画布列表/文件树/AI 会话）全部跳过
      try {
        await updateGlobalConfig({ recentVaults: recents });
      } catch (e) {
        console.error("登记最近仓库失败", e);
      }
      set({
        vaultRoot: info.root,
        vaultName: info.name,
        vaultId: info.id,
        recentVaults: recents,
        view: "workspace",
        canvases: [],
        currentCanvasId: null,
        currentCanvasFile: null,
        openTabs: [],
      });
      // 加载仓库级配置覆盖（.atelyx/config.json），需在发消息前完成
      await useSettingsStore.getState().loadVaultConfig();
      // 切换仓库：清空旧画布运行时状态（防残留 saveTimer 跨仓库写盘/旧消息残留）
      useCanvasStore.getState().resetCanvasState();
      // 文件树/画布列表/UI 状态/AI 会话后台填充：不阻塞工作区显示（启动提速，渐进加载）
      void (async () => {
        try {
          await get().loadList();
          await useVaultStore.getState().loadFiles();
          await useUiStateStore.getState().load();
          await useChatPanelStore.getState().load(info.id);
        } catch (e) {
          console.error("加载仓库数据失败", e);
        }
      })();
      return true;
    } catch (e) {
      console.error("打开仓库失败", e);
      return false;
    }
  },

  removeRecentVault: async (root) => {
    const recents = dropVaultFromRecents(get().recentVaults, root);
    try {
      await updateGlobalConfig({ recentVaults: recents });
    } catch (e) {
      console.error("更新最近仓库列表失败", e);
    }
    set({ recentVaults: recents });
  },

  backToVaultSelect: () => {
    // 回启动页前落盘当前仓库 UI 状态并**等待写盘完成**，随后 clear 清内存态：
    // 防 debounce 窗口内的旧 timer 在 vaultId 清空后仍触发、把状态写进下一个打开的仓库
    void useUiStateStore.getState().flush().finally(() => {
      useUiStateStore.getState().clear();
    });
    useSettingsStore.getState().clearVaultConfig();
    set({
      view: "vaultSelect",
      vaultRoot: null,
      vaultName: "",
      vaultId: null,
      canvases: [],
      currentCanvasId: null,
      currentCanvasFile: null,
      openTabs: [],
    });
  },

  pickVaultDirectory: () => pickDirectorySvc(),
  openInExplorer: (path) => openInExplorerSvc(path),
  openUrl: (url) => openUrlSvc(url),
  getAppVersion: () => getVersionSvc(),
  minimizeWindow: () => minimizeWindowSvc(),
  toggleMaximizeWindow: () => toggleMaximizeWindowSvc(),
  closeWindow: () => closeWindowSvc(),
  toggleFullscreen: () => toggleFullscreenSvc(),
  applyStartupWindow: () => applyStartupWindowSvc(),
  applyWorkspaceWindow: () => applyWorkspaceWindowSvc(),

  loadList: async () => {
    const vaultId = get().vaultId;
    try {
      const canvases = await listCanvasesVault();
      // 切仓库竞态守卫：等待期间用户可能已切到新仓库（后台填充链与 VaultSwitcher 快速切换并发），
      // 旧仓库的扫描结果不得覆盖新仓库的列表
      if (get().vaultId !== vaultId) return;
      set({ canvases });
    } catch (e) {
      console.error("加载画布列表失败", e);
    }
  },
  openCanvas: (row) => {
    const { openTabs } = get();
    // 标签：首次打开追加（已存在不重复）
    const tabs = openTabs.includes(row.id) ? openTabs : [...openTabs, row.id];
    set({ currentCanvasId: row.id, currentCanvasFile: row.file, openTabs: tabs });
  },
  closeCanvasFile: () => {
    set({ currentCanvasId: null, currentCanvasFile: null });
  },
  createCanvas: async (title = "未命名画布", dir = "") => {
    // 同名自动加序号（标题即文件名，保证同目录不重名），返回实际标题供 UI 提醒
    const siblings = get()
      .canvases.filter((c) => parentDir(c.file) === dir)
      .map((c) => c.title);
    const actual = dedupeFilename(title, siblings);
    try {
      const { id, file } = await createCanvasVault(actual, dir);
      markSelfSave();
      // 画布 CRUD 需同时刷新两个数据源：canvases 列表（appStore）+ 文件树（vaultStore.tree 含 .atlx 行），
      // 漏刷会导致文件面板不显示新画布，直到重进仓库（bug 修复
      await get().loadList();
      await useVaultStore.getState().loadFiles();
      return { id, file, title: actual };
    } catch (e) {
      console.error("新建画布失败", e);
      return { id: null, file: null, title: actual };
    }
  },
  renameCanvas: async (row, title) => {
    // 同名自动加序号（排除自身，同目录），返回实际标题供 UI 提醒
    const siblings = get()
      .canvases.filter((c) => parentDir(c.file) === parentDir(row.file))
      .map((c) => c.title)
      .filter((t) => t !== row.title);
    const actual = dedupeFilename(title, siblings);
    try {
      await renameCanvasVault(row.file, actual);
      markSelfSave();
      // 当前画布磁盘 .atlx 已被 Rust 改（title + 同目录改文件名），同步乐观锁基准防下次保存误冲突
      await useCanvasStore.getState().syncBaseUpdatedAt();
      // 重命名后文件名变了：同步当前画布 file（防下次保存写旧路径产生双文件）
      const newFile = siblingPath(row.file, `${sanitizeFilename(actual)}.atlx`);
      useUiStateStore.getState().renameLastCanvas(row.file, newFile);
      if (get().currentCanvasFile === row.file) {
        useCanvasStore.setState({ canvasFile: newFile });
      }
      await get().loadList();
      // 文件树同步刷新（.atlx 行名 = 文件名，重命名后需重新扫描）
      await useVaultStore.getState().loadFiles();
    } catch (e) {
      console.error("重命名失败", e);
    }
    return actual;
  },
  moveCanvas: async (row, targetDir) => {
    // 保持文件名，目标文件夹同名自动加序号（排除自身 = 同目录移动 no-op）
    const name = row.file.split("/").pop() ?? `${row.title}.atlx`;
    const siblings = get()
      .canvases.filter((c) => parentDir(c.file) === targetDir && c.file !== row.file)
      .map((c) => c.file.split("/").pop() ?? "");
    const safe = dedupeFilename(name, siblings);
    const newFile = targetDir ? `${targetDir}/${safe}` : safe;
    if (newFile === row.file) return row.file;
    try {
      await moveCanvasVault(row.file, newFile);
      markSelfSave();
      // 当前打开的就是被移动的画布：同步 file，防下次保存写旧路径产生双文件
      useUiStateStore.getState().renameLastCanvas(row.file, newFile);
      if (get().currentCanvasFile === row.file) {
        useCanvasStore.setState({ canvasFile: newFile });
      }
      await get().loadList();
      await useVaultStore.getState().loadFiles();
      return newFile;
    } catch (e) {
      // 不吞错误：调用方（FileExplorerPanel.handleMoveFile）据此提示「移动文件失败」
      console.error("移动画布失败", e);
      throw e;
    }
  },
  deleteCanvas: async (row) => {
    try {
      await deleteCanvasVault(row.file);
      markSelfSave();
      const { currentCanvasId, currentCanvasFile, openTabs } = get();
      const tabs = openTabs.filter((t) => t !== row.id);
      // 删除的是当前画布：清空 canvasStore（含未落盘 saveTimer / 进行中的流），
      // 否则残留 timer 会重写已删文件、watcher 事件匹配旧 id 产生误导 reload
      if (row.id === currentCanvasId) {
        useCanvasStore.getState().resetCanvasState();
      }
      // 删除的是「上次打开」的画布：清空 uiState 记录（否则下次进入仓库尝试恢复已删文件）
      if (useUiStateStore.getState().lastCanvasFile === row.file) {
        useUiStateStore.getState().closeCanvas();
      }
      set({
        openTabs: tabs,
        currentCanvasId: row.id === currentCanvasId ? null : currentCanvasId,
        currentCanvasFile: row.id === currentCanvasId ? null : currentCanvasFile,
      });
      await get().loadList();
      // 文件树同步刷新（.atlx 行从树中移除）
      await useVaultStore.getState().loadFiles();
    } catch (e) {
      console.error("删除失败", e);
    }
  },
  convertWhiteboard: async (file) => {
    const title = file.split("/").pop()?.replace(/\.canvas$/i, "") ?? "白板";
    // 同名自动加序号（同目录现有 .atlx 标题）
    const siblings = get()
      .canvases.filter((c) => parentDir(c.file) === parentDir(file))
      .map((c) => c.title);
    try {
      const row = await convertWhiteboardToAtlx(file, title, siblings);
      markSelfSave();
      // 转换生成了新 .atlx：刷新两个数据源（画布列表 + 文件树）
      await get().loadList();
      await useVaultStore.getState().loadFiles();
      return row;
    } catch (e) {
      console.error("转换为画布失败", e);
      return null;
    }
  },
}));
