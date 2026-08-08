import { create } from "zustand";
import { getApiKey, setApiKey, deleteApiKey } from "@/services/keychain";
import { readPromptNotes, readVaultConfig, writePromptNotes, writeVaultConfig } from "@/services/vault";
import { fetchProviderModels } from "@/services/ai/client";
import { useAppStore } from "@/stores/appStore";
import type {
  AiConfig,
  ChatTargetResult,
  FileExplorerSortKey,
  GlobalProvider,
  GlobalSearchConfig,
  ProviderConfig,
  ThemeMode,
  VaultConfig,
} from "@/types";
import { DEFAULT_AI_CONFIG } from "@/services/ai/types";
import { PROVIDER_PRESETS } from "@/constants/providers";
import { remapDirPrefix } from "@/utils/filename";

/**
 * 设置 store（配置全部仓库化）。
 *
 * 单一配置层（`.atelyx/config.json`）：AI 供应商 + 默认模型 +
 * 主题 + 搜索源 + 字体/排序等全部按仓库独立；API key 默认走 keychain 条目
 * `provider-<vaultId>-<providerId>`（**按仓库隔离**）；开启 `syncKeys`
 * （「API key 随仓库保存」，多设备同步）后 key 明文随 config.json 落盘。
 * `global.json` 只存最近仓库列表。
 *
 * 解析链（画布对话节点 / AI 对话面板共用 `resolveChatTarget`）：
 * 选定 {providerId, model}（无 = 跟随仓库默认）→ 供应商缺失报错不静默回落；
 * 未选定 = 仓库默认模型（vaultConfig.model，反查所属供应商），未配置默认模型报错；
 * 选定供应商但未选模型 = 供应商首个模型（models[0]）。
 *
 * 加载时机：selectVault → loadVaultConfig（读 config.json；syncKeys 关时从 keychain 填充 key，开时直读 config 内 key）；无仓库时状态为空。
 */

interface SettingsState {
  /** 运行时 AI 配置（providers 含 key，从 keychain 填充）。 */
  config: AiConfig;
  /** 仓库级主题模式（"system" = 跟随系统，由页面层解析 prefers-color-scheme）。 */
  theme: ThemeMode;
  /** 当前仓库级覆盖；null = 未打开仓库。 */
  vaultConfig: VaultConfig | null;
  /** 搜索源配置（仓库级，无 key；Tavily key 运行时从 keychain 读）。 */
  searchConfig: GlobalSearchConfig;
  /** Tavily API key（运行时，keychain 条目 `provider-<vaultId>-search-tavily`）。 */
  tavilyKey: string;
  /** 已标记为系统提示词的笔记相对路径列表（独立落盘 .atelyx/prompt-notes.json，config.json 不承载）。 */
  promptNotes: string[];
  loaded: boolean;

  /** 应用挂载时调用：重置运行时状态（配置已仓库化，无仓库上下文时为空）。 */
  load: () => Promise<void>;
  /** 打开仓库后读 `.atelyx/config.json`（主题/AI 供应商/搜索源等仓库级配置）+ keychain 填充 key。由 appStore.selectVault 调用。 */
  loadVaultConfig: () => Promise<void>;
  /** 返回仓库选择页时清空仓库级状态（配置/主题回默认）。由 appStore.backToVaultSelect 调用。 */
  clearVaultConfig: () => void;
  /** 设搜索源（仓库级，写 .atelyx/config.json）。 */
  setSearchConfig: (patch: Partial<GlobalSearchConfig>) => Promise<void>;
  /** 设 Tavily API key（仓库级；syncKeys 关 = 写 keychain 条目 `provider-<vaultId>-search-tavily`，开 = 随 config.json 落盘；空串删除）。 */
  setTavilyKey: (key: string) => Promise<void>;
  /** 开关「API key 随仓库保存」（多设备同步）：开启 = 当前 key 全量写入 config.json；关闭 = 剥离 config key + 回写 keychain。 */
  setSyncKeys: (enabled: boolean) => Promise<void>;
  /** 解析仓库默认模型及其所属供应商：默认模型可来自任意供应商（模型服务 tab 从全部供应商的 models 中选），按模型名定位；未配置返回 null。 */
  resolveDefaultModel: () => { provider: ProviderConfig; model: string } | null;
  /**
   * 解析一次对话请求的目标 {provider, model}（画布对话节点 / AI 对话面板共用）：
   * 选定 {providerId, model}（null = 跟随仓库默认）优先，**不回退默认**；选定供应商已删 → 报错不静默回落；
   * 未选定 = 仓库默认模型（vaultConfig.model，可来自任意供应商按 model 名反查），未配置默认模型 → 报错；
   * 选定供应商但未选模型 → 供应商首个模型（models[0]）。
   * 失败返回 {ok:false, reason, error}，调用方负责提示。
   */
  resolveChatTarget: (
    selection?: { providerId?: string; model?: string } | null,
  ) => ChatTargetResult;
  /** 搜索源是否已配置（tavily key 或 searxng URL 存在）——工具开关开着但未配置时发送提示并降级。 */
  isSearchConfigured: () => boolean;
  /** 解析话题自动命名模型：设置页指定（autoNamingModel）→ 仓库默认模型（vaultConfig.model）；未配置返回 null。ignoreToggle = 重新命名场景，不受「话题自动命名」开关限制。 */
  resolveAutoNamingModel: (ignoreToggle?: boolean) => { provider: ProviderConfig; model: string } | null;
  /** 新增 provider（基于预设或空白），返回新 id。 */
  addProvider: (preset?: (typeof PROVIDER_PRESETS)[number]) => Promise<string>;
  /** 拉取供应商可用模型 ID 列表（GET {baseUrl}/models；设置页「获取模型列表/测试连通性」共用）。失败抛错，由调用方降级展示。 */
  fetchProviderModelIds: (id: string) => Promise<string[]>;
  /** 更新 provider（debounce 落盘，含 keychain 写）。 */
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => Promise<void>;
  /** 删除 provider（同步删 keychain 条目）。 */
  removeProvider: (id: string) => Promise<void>;
  /** 设仓库级默认模型（null = 未配置——跟随默认的对话请求会报错提示）。 */
  setVaultModel: (model: string | null) => Promise<void>;
  /** 开关话题自动命名（仓库级；缺省开启）。 */
  setAutoNamingEnabled: (enabled: boolean) => Promise<void>;
  /** 设话题自动命名模型（null = 跟随默认模型；话题命名一般用小模型）。 */
  setAutoNamingModel: (model: { providerId: string; model: string } | null) => Promise<void>;
  /** 设仓库级界面基础字号（undefined = 跟随默认 18px）。 */
  setVaultFontSize: (size: number | undefined) => Promise<void>;
  /** 设仓库级界面字体（undefined = 跟随系统默认）。 */
  setVaultFontFamily: (family: string | undefined) => Promise<void>;
  /** 切换主题（仓库级，写入 .atelyx/config.json）。 */
  toggleTheme: () => Promise<void>;
  /** 文件面板排序方式（仓库级）。 */
  setFileExplorerSort: (sortKey: FileExplorerSortKey) => Promise<void>;
  /** 设置文件面板排除的文件夹名列表（仓库级；空数组 = 无排除）。 */
  setExcludeFolders: (folders: string[]) => Promise<void>;
  /** 设置附件导入默认文件夹（仓库级；undefined = 仓库根目录）。 */
  setAttachmentFolder: (folder: string | undefined) => Promise<void>;
  /** 设置宽松换行（仓库级）：开启时预览模式单个换行符渲染为换行（缺省 true）。 */
  setSoftLineBreak: (enabled: boolean) => Promise<void>;
  /** 设置进入仓库时是否自动恢复上次打开的文件（仓库级；缺省 true = 开启）。 */
  setAutoRestoreFiles: (enabled: boolean) => Promise<void>;
  /** 注册/注销系统提示词笔记（数组含该路径则移除，否则添加；写 .atelyx/prompt-notes.json）。 */
  togglePromptNote: (file: string) => Promise<void>;
  /** 笔记重命名/移动后同步标记路径（oldFile → newFile，写 .atelyx/prompt-notes.json）。 */
  remapPromptNote: (oldFile: string, newFile: string) => Promise<void>;
  /** 文件夹重命名后同步标记路径（`oldDir/` 前缀 → `newDir/`，写 .atelyx/prompt-notes.json）。 */
  remapPromptNotesByDir: (oldDir: string, newDir: string) => Promise<void>;
}

/** 运行时 ProviderConfig → 磁盘 GlobalProvider（syncKeys 开时带 apiKey 落盘，关时剥离；旧 model 字段一并剥离）。 */
function toGlobalProvider(p: ProviderConfig, syncKeys: boolean): GlobalProvider {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    models: p.models,
    ...(syncKeys && p.apiKey ? { apiKey: p.apiKey } : {}),
  };
}

/** 当前仓库稳定 ID（keychain 条目按仓库隔离用；设置入口只在工作区，必有当前仓库）。 */
function currentVaultId(): string {
  return useAppStore.getState().vaultId ?? "";
}

/** 写 keychain：有 key 则存、无 key 则删旧条目（清空 key 时真正移除，防止 loadVaultConfig 把旧 key 读回）。 */
async function persistKeys(vaultId: string, providers: ProviderConfig[]): Promise<void> {
  await Promise.all(
    providers.map((p) =>
      p.apiKey
        ? setApiKey(vaultId, p.id, p.apiKey).catch((e) => console.error("keychain 写入失败", p.id, e))
        : deleteApiKey(vaultId, p.id).catch((e) => console.error("keychain 删除失败", p.id, e)),
    ),
  );
}

/** 全量持久化：合并进仓库级配置写 `.atelyx/config.json` + 按 syncKeys 决定 key 落盘
 * （开 = key 随 config.json 落盘多设备同步；关 = key 写 keychain 按仓库隔离）。 */
async function persist(cfg: AiConfig): Promise<void> {
  // 捕获仓库快照：persist 是异步的（debounce 自动触发），期间用户可能已切换仓库，
  // 防 A 仓库的配置覆盖 B 仓库 config.json、A 的 key 写进 B 的 keychain 条目
  const vaultId = currentVaultId();
  if (!vaultId) return;
  const base = useSettingsStore.getState().vaultConfig ?? {};
  const syncKeys = !!base.syncKeys;
  const vc: VaultConfig = {
    ...base,
    providers: cfg.providers.length ? cfg.providers.map((p) => toGlobalProvider(p, syncKeys)) : undefined,
  };
  // 写盘前同步校验仓库未变；已切换则丢弃本次持久化（loadVaultConfig 已加载新仓库）
  if (currentVaultId() !== vaultId) return;
  useSettingsStore.setState({ vaultConfig: vc });
  await writeVaultConfig(cleanVaultConfig(vc));
  // syncKeys 开启时 key 已随 config.json 落盘，无需再写 keychain
  if (!syncKeys) await persistKeys(vaultId, cfg.providers);
}

// 输入框键击高频，debounce 后落盘避免每键一次 IPC + keychain 写入
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistDebounced(get: () => SettingsState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { config } = get();
    persist(config).catch((e) => console.error("保存 AI 配置失败", e));
  }, 400);
}

/** 写仓库级配置前剔除 undefined，保持 .atelyx/config.json 干净（providers 空数组不落盘）。 */
function cleanVaultConfig(vc: VaultConfig): VaultConfig {
  const out: VaultConfig = {};
  if (vc.theme !== undefined) out.theme = vc.theme;
  if (vc.model !== undefined) out.model = vc.model;
  if (vc.fontSize !== undefined) out.fontSize = vc.fontSize;
  if (vc.fontFamily !== undefined) out.fontFamily = vc.fontFamily;
  if (vc.fileExplorerSort !== undefined) out.fileExplorerSort = vc.fileExplorerSort;
  if (vc.excludeFolders !== undefined) out.excludeFolders = vc.excludeFolders;
  if (vc.attachmentFolder !== undefined) out.attachmentFolder = vc.attachmentFolder;
  if (vc.softLineBreak !== undefined) out.softLineBreak = vc.softLineBreak;
  if (vc.autoRestoreFiles !== undefined) out.autoRestoreFiles = vc.autoRestoreFiles;
  if (vc.autoNamingEnabled !== undefined) out.autoNamingEnabled = vc.autoNamingEnabled;
  if (vc.autoNamingModel !== undefined) out.autoNamingModel = vc.autoNamingModel;
  // 仓库级 AI 配置（无 key）与仓库稳定 ID 必须保留：否则写盘后供应商/搜索源丢失，
  // vaultId 消失会让下次 open_vault 重新生成 ID、keychain key 失配
  if (vc.providers !== undefined) out.providers = vc.providers;
  if (vc.search !== undefined) out.search = vc.search;
  if (vc.syncKeys !== undefined) out.syncKeys = vc.syncKeys;
  if (vc.vaultId !== undefined) out.vaultId = vc.vaultId;
  // dirNames / temperature / defaultProviderId 字段不写回（配置中不再承载）
  return out;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: DEFAULT_AI_CONFIG,
  theme: "dark",
  vaultConfig: null,
  searchConfig: { provider: "tavily", searxngUrl: "" },
  tavilyKey: "",
  promptNotes: [],
  loaded: false,

  load: async () => {
    // 配置已全部仓库化：无仓库上下文时仅重置运行时状态（进入仓库后由 loadVaultConfig 填充）
    set({
      config: DEFAULT_AI_CONFIG,
      theme: "dark",
      searchConfig: { provider: "tavily", searxngUrl: "" },
      tavilyKey: "",
      promptNotes: [],
      loaded: true,
    });
  },

  loadVaultConfig: async () => {
    try {
      const vc = await readVaultConfig();
      const vaultId = currentVaultId();
      // 仓库级 AI 供应商：syncKeys 开 = key 随仓库落盘直读 config（多设备共享）；关 = 从 keychain 按仓库隔离填充
      const providers = await Promise.all(
        (vc.providers ?? []).map(async (p): Promise<ProviderConfig> => {
          let apiKey = "";
          if (vc.syncKeys) {
            apiKey = p.apiKey ?? "";
          } else {
            try {
              apiKey = await getApiKey(vaultId, p.id);
            } catch (e) {
              console.error("keychain 读取失败", p.id, e);
            }
          }
          return { id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models ?? [], apiKey };
        }),
      );
      const config: AiConfig = { providers };
      // 搜索源：仓库级配置 + Tavily key（syncKeys 开 = 直读 config 内 tavilyApiKey；关 = keychain 条目 provider-<vaultId>-search-tavily）
      let searchConfig: GlobalSearchConfig = { provider: "tavily", searxngUrl: "" };
      let tavilyKey = "";
      if (vc.search) searchConfig = vc.search;
      if (vc.syncKeys) {
        tavilyKey = searchConfig.tavilyApiKey ?? "";
      } else {
        try {
          tavilyKey = await getApiKey(vaultId, "search-tavily");
        } catch (e) {
          console.error("keychain 读取失败 search-tavily", e);
        }
      }
      // 系统提示词标记独立落盘 .atelyx/prompt-notes.json（config.json 只存仓库配置）
      let promptNotes: string[] = [];
      try {
        promptNotes = await readPromptNotes();
      } catch (e) {
        console.error("读取系统提示词标记失败", e);
      }
      set({
        vaultConfig: vc,
        config,
        searchConfig,
        tavilyKey,
        promptNotes,
        // 仓库主题；非法值（手改 config.json）退化为深色。"system" 原样保留（页面层解析）
        theme: vc.theme === "light" || vc.theme === "dark" || vc.theme === "system" ? vc.theme : "dark",
      });
    } catch (e) {
      console.error("读取仓库级配置失败", e);
    }
  },

  clearVaultConfig: () =>
    set({
      vaultConfig: null,
      theme: "dark",
      config: DEFAULT_AI_CONFIG,
      searchConfig: { provider: "tavily", searxngUrl: "" },
      tavilyKey: "",
      promptNotes: [],
    }),

  // 话题自动命名模型解析：设置页指定（autoNamingModel）→ 仓库默认模型（vaultConfig.model）；
  // 开关未配置视为开启（缺省 true），显式关闭返回 null（画布/面板自动命名共用，一次定义）；
  // ignoreToggle = 重新命名（用户显式请求，独立于自动命名开关）。
  resolveAutoNamingModel: (ignoreToggle) => {
    const s = get();
    const vault = s.vaultConfig;
    if (vault?.autoNamingEnabled === false && !ignoreToggle) return null;
    const named = vault?.autoNamingModel;
    const modelId = named?.model || vault?.model;
    if (!modelId) return null;
    const provider =
      (named?.providerId
        ? s.config.providers.find((p) => p.id === named.providerId)
        : undefined) ?? s.config.providers.find((p) => p.models.some((m) => m.id === modelId));
    if (!provider) return null;
    return { provider, model: modelId };
  },

  isSearchConfigured: () => {
    const s = get();
    return s.searchConfig.provider === "tavily" ? !!s.tavilyKey : !!s.searchConfig.searxngUrl;
  },

  resolveDefaultModel: () => {
    const { config, vaultConfig } = get();
    const vaultModel = vaultConfig?.model;
    if (!vaultModel) return null;
    // 默认模型可来自任意供应商：按模型名反查所属供应商
    const owner = config.providers.find((p) => p.models.some((m) => m.id === vaultModel));
    if (!owner) return null;
    return { provider: owner, model: vaultModel };
  },

  // 对话请求目标统一解析（画布节点 selection = 节点级指定；面板 selection = modelOverride）。
  // 语义：选定 {providerId, model} 优先（供应商已删报错不静默回落）；未选定 = 跟随仓库默认模型（反查所属供应商），未配置默认模型报错。
  resolveChatTarget: (selection) => {
    const s = get();
    const selected = selection?.providerId
      ? s.config.providers.find((p) => p.id === selection.providerId)
      : undefined;
    if (selection?.providerId && !selected) {
      return {
        ok: false,
        reason: "provider-missing",
        error: "所选供应商已不存在，请重新选择",
      };
    }
    if (!selected) {
      const def = s.resolveDefaultModel();
      if (!def) {
        return {
          ok: false,
          reason: "no-model",
          error: "未配置默认模型：请在设置 → 模型服务中配置默认模型，或在本节点选择模型",
        };
      }
      return { ok: true, provider: def.provider, model: def.model };
    }
    const model = selection?.model ?? selected.models[0]?.id ?? "";
    if (!model) {
      return {
        ok: false,
        reason: "no-model",
        error: "未指定模型：请选择模型，或在设置中设置默认模型",
      };
    }
    return { ok: true, provider: selected, model };
  },

  addProvider: async (preset) => {
    const id = crypto.randomUUID();
    const provider: ProviderConfig = {
      id,
      name: preset?.name ?? "自定义",
      baseUrl: preset?.baseUrl ?? "",
      apiKey: "",
      models: preset?.models ?? [],
    };
    const cfg = {
      providers: [...get().config.providers, provider],
    };
    set({ config: cfg });
    persist(cfg).catch((e) => console.error("保存 AI 配置失败", e));
    return id;
  },

  fetchProviderModelIds: async (id) => {
    const p = get().config.providers.find((x) => x.id === id);
    if (!p) throw new Error("供应商不存在");
    return fetchProviderModels(p.baseUrl, p.apiKey);
  },

  updateProvider: async (id, patch) => {
    const providers = get().config.providers.map((p) =>
      p.id === id ? { ...p, ...patch } : p,
    );
    const cfg = { ...get().config, providers };
    set({ config: cfg });
    persistDebounced(get);
  },

  removeProvider: async (id) => {
    const providers = get().config.providers.filter((p) => p.id !== id);
    const cfg = { providers };
    set({ config: cfg });
    await persist(cfg);
    // 删 keychain 条目（best-effort；key 按仓库隔离，无条件删）
    deleteApiKey(currentVaultId(), id).catch((e) => console.error("删除 keychain 条目失败", id, e));
  },

  setVaultModel: async (model) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, model: model ?? undefined };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setAutoNamingEnabled: async (enabled) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, autoNamingEnabled: enabled };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setAutoNamingModel: async (model) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, autoNamingModel: model ?? undefined };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setVaultFontSize: async (size) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, fontSize: size };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setVaultFontFamily: async (family) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, fontFamily: family };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  /** 切换主题模式：light → dark → system 循环（跟随系统 = 按系统外观实时解析）。 */
  toggleTheme: async () => {
    const next: ThemeMode =
      get().theme === "light" ? "dark" : get().theme === "dark" ? "system" : "light";
    set({ theme: next });
    // 主题仓库化：写入 .atelyx/config.json（设置入口只在工作区，必有当前仓库）
    if (get().vaultConfig) {
      const vc: VaultConfig = { ...get().vaultConfig, theme: next };
      set({ vaultConfig: vc });
      try {
        await writeVaultConfig(cleanVaultConfig(vc));
      } catch (e) {
        console.error("保存仓库级配置失败", e);
      }
    }
  },

  setFileExplorerSort: async (sortKey) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, fileExplorerSort: sortKey };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setExcludeFolders: async (folders) => {
    const base = get().vaultConfig ?? {};
    // 空数组不落盘（缺省 = 无排除，保持 config.json 干净）
    const vc: VaultConfig = { ...base, excludeFolders: folders.length ? folders : undefined };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setSoftLineBreak: async (enabled) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, softLineBreak: enabled };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setAutoRestoreFiles: async (enabled) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, autoRestoreFiles: enabled };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  setAttachmentFolder: async (folder) => {
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, attachmentFolder: folder || undefined };
    set({ vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
  },

  /** 注册/注销系统提示词笔记：数组含该路径则移除，否则添加（空数组也落盘保持文件干净，独立于 config.json）。 */
  togglePromptNote: async (file) => {
    const marked = get().promptNotes.includes(file);
    const next = marked
      ? get().promptNotes.filter((f) => f !== file)
      : [...get().promptNotes, file];
    set({ promptNotes: next });
    try {
      await writePromptNotes(next);
    } catch (e) {
      console.error("保存系统提示词标记失败", e);
    }
  },

  /** 笔记重命名/移动后同步标记路径（旧路径未标记时 no-op）。 */
  remapPromptNote: async (oldFile, newFile) => {
    const marked = get().promptNotes;
    if (!marked.includes(oldFile)) return;
    const next = marked.map((f) => (f === oldFile ? newFile : f));
    set({ promptNotes: next });
    try {
      await writePromptNotes(next);
    } catch (e) {
      console.error("保存系统提示词标记失败", e);
    }
  },

  /** 文件夹重命名后同步标记路径（`oldDir/` 前缀命中才更新）。 */
  remapPromptNotesByDir: async (oldDir, newDir) => {
    const marked = get().promptNotes;
    const next = marked.map((f) => remapDirPrefix(f, oldDir, newDir));
    if (next.every((f, i) => f === marked[i])) return;
    set({ promptNotes: next });
    try {
      await writePromptNotes(next);
    } catch (e) {
      console.error("保存系统提示词标记失败", e);
    }
  },

  setSearchConfig: async (patch) => {
    const next = { ...get().searchConfig, ...patch };
    const base = get().vaultConfig ?? {};
    const vc: VaultConfig = { ...base, search: next };
    set({ searchConfig: next, vaultConfig: vc });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存搜索源配置失败", e);
    }
  },

  setTavilyKey: async (key) => {
    set({ tavilyKey: key });
    const vaultId = currentVaultId();
    try {
      if (get().vaultConfig?.syncKeys) {
        // syncKeys 开启：Tavily key 随仓库落盘（search.tavilyApiKey，空串剥离）
        const searchConfig = { ...get().searchConfig, tavilyApiKey: key || undefined };
        const vc: VaultConfig = { ...(get().vaultConfig ?? {}), search: searchConfig };
        set({ searchConfig, vaultConfig: vc });
        await writeVaultConfig(cleanVaultConfig(vc));
      } else if (key) {
        // 默认：key 走 keychain（条目 `provider-<vaultId>-search-tavily`，与 provider key 区分）；空串删除条目
        await setApiKey(vaultId, "search-tavily", key);
      } else {
        await deleteApiKey(vaultId, "search-tavily");
      }
    } catch (e) {
      console.error("保存 Tavily key 失败", e);
    }
  },

  /** 开关「API key 随仓库保存」（多设备同步）：开启 = 当前 key 全量写入 config.json；
   * 关闭 = 剥离 config 内 key + 回写 keychain（覆盖旧条目，防开启期间 key 变更丢同步）。 */
  setSyncKeys: async (enabled) => {
    const base = get().vaultConfig ?? {};
    const { config, searchConfig, tavilyKey } = get();
    // searchConfig 必须与磁盘同步更新：开 = 带 tavilyApiKey（后续 setSearchConfig 写回不丢 key），
    // 关 = 剥离（防残留 key 被 setSearchConfig 重新写回 config.json，破坏「关闭 = 剥离」语义）
    const hasSearch = base.search !== undefined || searchConfig.tavilyApiKey !== undefined;
    const nextSearch: GlobalSearchConfig | undefined = enabled
      ? { ...searchConfig, tavilyApiKey: tavilyKey || undefined }
      : hasSearch
        ? { provider: searchConfig.provider, searxngUrl: searchConfig.searxngUrl }
        : undefined;
    const vc: VaultConfig = {
      ...base,
      syncKeys: enabled,
      // 开启：key 随供应商/搜索配置落盘；关闭：剥离 key 字段（key 由下方回写 keychain）
      providers: config.providers.length
        ? config.providers.map((p) => toGlobalProvider(p, enabled))
        : base.providers,
      search: nextSearch,
    };
    set({ vaultConfig: vc, searchConfig: nextSearch ?? { provider: "tavily", searxngUrl: "" } });
    try {
      await writeVaultConfig(cleanVaultConfig(vc));
    } catch (e) {
      console.error("保存仓库级配置失败", e);
    }
    if (!enabled) {
      // 关闭：key 从 config 剥离后回写 keychain（best-effort）
      const vaultId = currentVaultId();
      await persistKeys(vaultId, config.providers);
      try {
        if (tavilyKey) await setApiKey(vaultId, "search-tavily", tavilyKey);
        else await deleteApiKey(vaultId, "search-tavily");
      } catch (e) {
        console.error("保存 Tavily key 失败", e);
      }
    }
  },
}));
