/**
 * 插件平台 store：已装插件状态（app + 当前仓库 vault）+ 运行时生命周期编排。
 *
 * 分层：本 store 是插件相关状态的唯一出口——组件不直连 `services/plugins`；
 * 运行时（Worker/桥）本体在 `services/plugins/bridge`，本 store 只做编排与快照。
 * 加载时机：应用挂载/进仓后 `load()` 一次——先列清单，再逐个拉起启用插件（单个失败不影响其余）。
 */
import { create } from "zustand";
import type { ComponentType } from "react";
import type { InstalledPlugin, PluginIndexEntry, PluginScope, SuiteManifest, ToolDefinition } from "@/types";
import { errText } from "@/types";
import {
  contributedPluginTools,
  exposePluginFacade,
  getPluginAppPages,
  getPluginNode,
  getPluginNodes,
  getPluginPanel,
  getPluginPanels,
  getPluginSetting,
  getPluginSettings,
  loadPlugin,
  loadUiPlugin,
  onPluginUiChange,
  onRuntimeChange,
  pluginInstall,
  pluginList,
  pluginReadEntry,
  pluginSetEnabled,
  pluginUninstall,
  pluginUpdate,
  pluginViewKinds as allPluginViewKinds,
  pluginViewLabel as pluginViewLabelOf,
  runtimeSnapshot,
  unloadPlugin,
  unregisterPluginUi,
} from "@/services/plugins";
import type {
  PluginAppPageRegistration,
  PluginNodeRegistration,
  PluginPanelRegistration,
  PluginSettingRegistration,
} from "@/services/plugins";
import { pluginToolMetas as pluginToolMetasSvc } from "@/services/ai/tools";
import type { AgentToolMeta } from "@/constants/tools";
import {
  fetchMarketIndex,
  fetchSuites,
  isMarketStale,
  readMarketCache,
  readSuitesCache,
} from "@/services/plugins/market";
import { getAppVersion } from "@/services/app";
import {
  isUiPluginType,
  isWorkerPluginType,
  pluginCompatibleWithHost,
  pluginTypeList,
  validatePluginManifest,
} from "@/utils/pluginManifest";
import { detectPlatform } from "@/utils/pluginHost";

interface PluginStoreState {
  /** 已装插件（按 id；运行时阶段/审计与磁盘行合并）。 */
  plugins: Record<string, InstalledPlugin>;
  /** 已初始化（应用挂载/进仓后加载一次）。 */
  initialized: boolean;
  /** UI 注册修订号（主线程插件脚本异步注册到达时自增；依赖插件 UI 的组件据此重渲染）。 */
  uiRevision: number;
  /** 市场索引条目（含徽标/封禁合并）。 */
  marketItems: PluginIndexEntry[];
  marketGeneratedAt: string;
  marketFetchedAt: number;
  marketLoading: boolean;
  marketError: string;
  /** 市场是否已加载过（UI 据此显示加载/空态）。 */
  marketLoaded: boolean;
  /** 套件清单（一键装配）。 */
  suites: SuiteManifest[];
  suitesLoading: boolean;
  suitesError: string;
  /** 加载已装插件并按启用状态拉起运行时。 */
  load(): Promise<void>;
  /** 从 GitHub 仓库安装（scope 由前端/清单决定；安装后默认未启用，由管理 UI 确认后启用；
   * skipReload 供套件批量安装时跳过逐成员全量重载，由装配末尾统一 load）。 */
  install(repo: string, scope: PluginScope, skipReload?: boolean): Promise<void>;
  /** 卸载（删除目录 + 终止运行时 + 清理状态）。 */
  uninstall(id: string): Promise<void>;
  /** 启用/停用（启用 = 拉起运行时；停用 = 终止运行时）。 */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** 更新（备份 → 安装 → 失败回滚；成功则重载运行时）。 */
  update(id: string): Promise<void>;
  /** 插件贡献的 AI 工具（Agent 名册组装用）。 */
  pluginTools(): ToolDefinition[];
  /** 插件工具的 UI 元数据（Agent 设置页名册合并；组件经此读取，不直连 services）。 */
  pluginToolMetas(): AgentToolMeta[];
  /** 插件面板注册（kind → 注册；ViewHost 渲染 + 视图菜单合并）。 */
  pluginPanels(): PluginPanelRegistration[];
  pluginPanel(kind: string): PluginPanelRegistration | undefined;
  /** 插件设置项注册（设置页 tab 合并）。 */
  pluginSettings(): PluginSettingRegistration[];
  pluginSetting(key: string): PluginSettingRegistration | undefined;
  /** 插件画布节点注册（CanvasView nodeTypes 合并）。 */
  pluginNode(type: string): PluginNodeRegistration | undefined;
  /** 插件画布节点组件表（nodeTypes 合并用：type → component）。 */
  pluginNodeTypes(): Record<string, ComponentType>;
  /** 插件应用页面注册（app 页面/模式全页接管）。 */
  pluginAppPage(id: string): PluginAppPageRegistration | undefined;
  /** 面板视图候选（内建 + 插件面板）。 */
  pluginViewKinds(): string[];
  /** 视图显示名（含插件面板，未知视图原样兜底）。 */
  pluginViewLabel(view: string): string;
  /** 加载市场索引（缓存未过期直接回缓存；失败回落缓存快照并带时间戳提示）。 */
  loadMarket(force?: boolean): Promise<void>;
  /** 加载套件清单。 */
  loadSuites(force?: boolean): Promise<void>;
  /** 一键装配套件：安装成员插件（按市场索引解析 repo；封禁/缺失跳过）→ 刷新 → 启用套件声明的皮肤。 */
  assembleSuite(suite: SuiteManifest, scope: PluginScope): Promise<{ installed: string[]; skipped: string[] }>;
}

/** 磁盘行 → store 条目（清单经前端校验归一化；Rust 侧 plugin_list 已滤除损坏清单，
 * 此处回退 cast 仅兜底意外形态——正常路径 validated.ok 恒真）。 */
function toInstalled(row: {
  id: string;
  scope: PluginScope;
  installDir: string;
  enabled: boolean;
  manifest: unknown;
}): InstalledPlugin {
  const validated = validatePluginManifest(row.manifest);
  return {
    id: row.id,
    manifest: validated.ok ? validated.manifest : (row.manifest as InstalledPlugin["manifest"]),
    scope: row.scope,
    installDir: row.installDir,
    enabled: row.enabled,
    phase: "pending",
    usedCapabilities: [],
  };
}

export const usePluginStore = create<PluginStoreState>()((set, get) => {
  /** 把运行时快照合并回 store（加载/激活/失败/卸载事件驱动）。 */
  const reconcile = (): void => {
    const entries = runtimeSnapshot();
    set((s) => {
      let changed = false;
      const plugins = { ...s.plugins };
      for (const e of entries) {
        const p = plugins[e.id];
        if (!p) continue;
        plugins[e.id] = { ...p, phase: e.phase, usedCapabilities: e.used, error: e.error };
        changed = true;
      }
      return changed ? { plugins } : s;
    });
  };

  /** 拉起单个启用插件的运行时（按平面：主线程 UI 入口 + worker 逻辑；失败标 failed 不阻塞）。 */
  const spawn = async (id: string): Promise<void> => {
    const p = get().plugins[id];
    if (!p) return;
    // 先撤销旧贡献（重载防重复注册）。
    unregisterPluginUi(id);
    unloadPlugin(id);
    try {
      const types = pluginTypeList(p.manifest);
      const hasWorker = types.some(isWorkerPluginType);
      // 主线程平面：mainUi 优先；无 mainUi 时仅当无 worker 平面才把 main 当 UI 入口
      // （否则同一份 main 会被双平面各执行一次——混合类型插件必须用 mainUi 承载 UI）。
      const uiEntry =
        p.manifest.mainUi ?? (!hasWorker && types.some(isUiPluginType) ? p.manifest.main : undefined);
      if (uiEntry) {
        const code = await pluginReadEntry(id, uiEntry);
        loadUiPlugin(id, code);
      }
      // worker 平面：工具/后台/命令逻辑。
      if (hasWorker && p.manifest.main) {
        const code = await pluginReadEntry(id, p.manifest.main);
        const entry = loadPlugin(p.manifest, code);
        set((s) => {
          const cur = s.plugins[id];
          if (!cur) return s;
          return { plugins: { ...s.plugins, [id]: { ...cur, phase: entry.phase, error: entry.error } } };
        });
      } else {
        // 无 worker 平面：主线程脚本注入后即视为已加载（注册经 onPluginUiChange 刷新 UI）。
        set((s) => {
          const cur = s.plugins[id];
          if (!cur) return s;
          return { plugins: { ...s.plugins, [id]: { ...cur, phase: "active" } } };
        });
      }
    } catch (e) {
      set((s) => {
        const cur = s.plugins[id];
        if (!cur) return s;
        return { plugins: { ...s.plugins, [id]: { ...cur, phase: "failed", error: errText(e) } } };
      });
    }
  };

  onRuntimeChange(reconcile);
  onPluginUiChange(() => set((s) => ({ uiRevision: s.uiRevision + 1 })));

  /** load 序号守卫：并发 load（回启动页 fire-and-forget 与紧接着进仓 load 竞态）时
   * 只允许最后一次生效，防止旧 load 覆盖插件表后残留孤儿 runtime。 */
  let loadSeq = 0;

  /** 封禁落地：把市场封禁标记到已装插件，启用中的被强制停用（下架即禁用，符合市场承诺）。 */
  const applyBlocklist = (): void => {
    const blocked = new Map<string, string>();
    for (const it of get().marketItems) if (it.blockedReason) blocked.set(it.id, it.blockedReason);
    for (const p of Object.values(get().plugins)) {
      const reason = blocked.get(p.id);
      if (p.enabled && reason) void get().setEnabled(p.id, false).catch(() => {});
      if (p.blocked !== reason) {
        set((s) =>
          s.plugins[p.id]
            ? { plugins: { ...s.plugins, [p.id]: { ...s.plugins[p.id], blocked: reason } } }
            : s,
        );
      }
    }
  };

  return {
    plugins: {},
    initialized: false,
    uiRevision: 0,
    marketItems: [],
    marketGeneratedAt: "",
    marketFetchedAt: 0,
    marketLoading: false,
    marketError: "",
    marketLoaded: false,
    suites: [],
    suitesLoading: false,
    suitesError: "",

    /**
     * 全量重载：先卸载全部运行时与 UI 贡献（仓库切换/重装后旧贡献不残留），再按当前上下文
     * （app 插件 + 当前仓库 vault 插件）重建。语义 =「重置到磁盘状态」，可在 boot / 切仓库 /
     * 安装/更新后安全重复调用。
     */
    load: async () => {
      exposePluginFacade();
      const seq = ++loadSeq;
      for (const id of Object.keys(get().plugins)) {
        unloadPlugin(id);
        unregisterPluginUi(id);
      }
      const rows = await pluginList();
      if (seq !== loadSeq) return; // 已有更新的 load 开始，本次作废（防孤儿 runtime）
      const plugins: Record<string, InstalledPlugin> = {};
      for (const row of rows) {
        plugins[row.id] = toInstalled(row);
      }
      set({ plugins, initialized: true });
      for (const row of rows) {
        if (!row.enabled) continue;
        if (seq !== loadSeq) return;
        await spawn(row.id);
      }
      if (seq !== loadSeq) return;
      // 封禁标记补录（市场已加载时）：重新标记已装插件并强制停用下架项。
      if (get().marketLoaded) applyBlocklist();
    },

    install: async (repo, scope, skipReload = false) => {
      const row = await pluginInstall(repo, scope);
      try {
        // 封禁检查（市场已加载时）：命中即回滚——已下架插件不可安装。
        if (get().marketItems.find((it) => it.id === row.id)?.blockedReason) {
          throw new Error("该插件已被官方下架，无法安装");
        }
        // 宿主兼容强制（清单承诺）：版本/平台不匹配即回滚并报错。
        const hostVersion = await getAppVersion();
        const compat = pluginCompatibleWithHost(row.manifest, hostVersion, detectPlatform());
        if (!compat.ok) throw new Error(`无法安装：${compat.reason}`);
      } catch (e) {
        // 任一检查失败（含 getAppVersion IPC 异常）都回滚已落盘插件，避免「装了一半」留脏。
        await pluginUninstall(row.id, row.scope).catch(() => {});
        throw e;
      }
      if (!skipReload) await get().load();
    },

    uninstall: async (id) => {
      const p = get().plugins[id];
      if (!p) return;
      unloadPlugin(id);
      unregisterPluginUi(id);
      await pluginUninstall(id, p.scope);
      set((s) => {
        const plugins = { ...s.plugins };
        delete plugins[id];
        return { plugins };
      });
    },

    setEnabled: async (id, enabled) => {
      const p = get().plugins[id];
      if (!p || p.enabled === enabled) return;
      if (enabled && p.blocked) return; // 已下架插件不可重新启用
      await pluginSetEnabled(id, enabled);
      if (enabled) {
        set((s) => ({
          plugins: { ...s.plugins, [id]: { ...s.plugins[id], enabled } },
        }));
        await spawn(id);
      } else {
        unloadPlugin(id);
        unregisterPluginUi(id);
        // 复位运行阶段（桥已移除运行时，store 残留的 active 是过期状态）。
        set((s) => {
          const cur = s.plugins[id];
          if (!cur) return s;
          return { plugins: { ...s.plugins, [id]: { ...cur, enabled: false, phase: "pending", error: undefined } } };
        });
      }
    },

    update: async (id) => {
      unloadPlugin(id);
      unregisterPluginUi(id);
      await pluginUpdate(id);
      // load 按 enabled 状态自动重拉（enabled 由状态文件保持），无需再显式 spawn。
      await get().load();
    },

    pluginTools: () => contributedPluginTools(),

    pluginToolMetas: () => pluginToolMetasSvc(),

    pluginPanels: () => getPluginPanels(),
    pluginPanel: (kind) => getPluginPanel(kind),
    pluginSettings: () => getPluginSettings(),
    pluginSetting: (key) => getPluginSetting(key),
    pluginNode: (type) => getPluginNode(type),
    pluginNodeTypes: () => {
      const out: Record<string, ComponentType> = {};
      for (const reg of getPluginNodes()) out[reg.type] = reg.component;
      return out;
    },
    pluginAppPage: (id) => getPluginAppPages().find((p) => p.id === id),
    pluginViewKinds: () => allPluginViewKinds(),
    pluginViewLabel: (view) => pluginViewLabelOf(view),

    loadMarket: async (force = false) => {
      const cached = readMarketCache();
      if (!force && cached && !isMarketStale(cached.fetchedAt)) {
        set({
          marketItems: cached.items,
          marketGeneratedAt: cached.generatedAt,
          marketFetchedAt: cached.fetchedAt,
          marketLoaded: true,
          marketLoading: false,
          marketError: "",
        });
        applyBlocklist();
        return;
      }
      set({ marketLoading: true, marketError: "" });
      try {
        const snap = await fetchMarketIndex();
        set({
          marketItems: snap.items,
          marketGeneratedAt: snap.generatedAt,
          marketFetchedAt: snap.fetchedAt,
          marketLoaded: true,
          marketLoading: false,
        });
        applyBlocklist();
      } catch (e) {
        if (cached) {
          set({
            marketItems: cached.items,
            marketGeneratedAt: cached.generatedAt,
            marketFetchedAt: cached.fetchedAt,
            marketLoaded: true,
            marketLoading: false,
            marketError: `市场刷新失败，使用缓存快照`,
          });
          applyBlocklist();
        } else {
          set({ marketLoading: false, marketError: `市场加载失败：${errText(e)}` });
        }
      }
    },

    loadSuites: async (force = false) => {
      const cached = readSuitesCache();
      if (!force && cached.length > 0) {
        set({ suites: cached, suitesLoading: false, suitesError: "" });
        return;
      }
      set({ suitesLoading: true, suitesError: "" });
      try {
        const suites = await fetchSuites();
        set({ suites, suitesLoading: false });
      } catch (e) {
        if (cached.length > 0) {
          set({ suites: cached, suitesLoading: false, suitesError: "套件刷新失败，使用缓存快照" });
        } else {
          set({ suitesLoading: false, suitesError: `套件加载失败：${errText(e)}` });
        }
      }
    },

    assembleSuite: async (suite, scope) => {
      const index = new Map(get().marketItems.map((it) => [it.id, it]));
      const installed: string[] = [];
      const skipped: string[] = [];
      for (const memberId of suite.plugins) {
        const entry = index.get(memberId);
        if (!entry || entry.blockedReason) {
          skipped.push(memberId);
          continue;
        }
        try {
          // 批量安装：skipReload=true 避免 N 成员 N 次全量重载，末尾统一 load 一次。
          await get().install(entry.repo, scope, true);
          installed.push(memberId);
        } catch {
          skipped.push(memberId);
        }
      }
      await get().load();
      // 套件声明的皮肤：装配完成后启用（用户主动装配即视为确认）。
      if (suite.themeId && get().plugins[suite.themeId]) {
        await get().setEnabled(suite.themeId, true);
      }
      return { installed, skipped };
    },
  };
});
