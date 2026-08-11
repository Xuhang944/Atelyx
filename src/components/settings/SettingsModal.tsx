import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  Info,
  PenLine,
  RotateCcw,
  Search,
  Server,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import { useVaultStore } from "@/stores/vaultStore";
import { ProviderSettingsSection } from "@/components/settings/ProviderSettingsSection";
import { AboutSection } from "@/components/settings/AboutSection";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import { ToggleSwitch } from "@/components/common/ToggleSwitch";
import { modelNameAcrossProviders } from "@/utils/text";
import { DEFAULT_ACCENT, foregroundFor } from "@/utils/color";

type Tab =
  | "general"
  | "providers"
  | "modelServices"
  | "search"
  | "files"
  | "editor"
  | "about";

/** 左侧 tab 栏配置（图标 + 标签；折叠后仅显示图标）。 */
const TAB_ITEMS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "general", label: "通用", icon: Settings },
  { key: "providers", label: "模型供应商", icon: Server },
  { key: "modelServices", label: "模型服务", icon: Bot },
  { key: "search", label: "联网搜索", icon: Search },
  { key: "files", label: "文件与路径", icon: FolderTree },
  { key: "editor", label: "编辑器", icon: PenLine },
  { key: "about", label: "关于", icon: Info },
];

/** 界面字体选项（value = CSS font-family；空串 = 跟随系统默认）。 */
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "跟随系统", value: "" },
  {
    label: "无衬线",
    value: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  { label: "衬线", value: "Georgia, 'Times New Roman', serif" },
  { label: "等宽", value: "Consolas, 'Courier New', monospace" },
];
/** 话题自动命名下拉「跟随默认模型」哨兵值（与任何模型 id 区分；空串 = 不启用）。 */
const AUTO_NAMING_DEFAULT = "__default__";
/** 强调色预设色板（600/700 阶深色系：白字对比 ≥ 5:1，金色默认由「恢复默认」按钮回归；取色器可自由选色）。 */
const ACCENT_PRESETS = [
  "#2563eb",
  "#0d9488",
  "#7c3aed",
  "#dc2626",
  "#15803d",
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const vaultConfig = useSettingsStore((s) => s.vaultConfig);
  // 应用级外观（跨仓库共享，global.json）：强调色 / 字号 / 字体 / 自动恢复（theme/toggleTheme 在下方声明）
  const accentColor = useSettingsStore((s) => s.accentColor);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const autoRestoreFiles = useSettingsStore((s) => s.autoRestoreFiles);
  // 仓库内设置（仓库级，七 tab）：通用 / 模型供应商 / 模型服务 / 联网搜索 / 文件与路径 / 编辑器 / 关于
  const [tab, setTab] = useState<Tab>("general");
  /** 强调色取色器草稿：取色器拖动连续触发 onChange，防抖 200ms 后落盘（避免每帧一次配置原子写）。 */
  const [accentDraft, setAccentDraft] = useState(accentColor ?? DEFAULT_ACCENT);
  const accentTimerRef = useRef<number | null>(null);
  const commitAccentDraft = (v: string) => {
    setAccentDraft(v);
    if (accentTimerRef.current !== null) window.clearTimeout(accentTimerRef.current);
    accentTimerRef.current = window.setTimeout(() => {
      accentTimerRef.current = null;
      void setAccentColor(v);
    }, 200);
  };
  useEffect(() => {
    return () => {
      if (accentTimerRef.current !== null) window.clearTimeout(accentTimerRef.current);
    };
  }, []);
  /** 左侧 tab 栏折叠状态（折叠后仅显示图标）。 */
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  /** 重建内部链接：确认弹窗 / 执行中 / 内联结果（编辑器 tab）。 */
  const [rebuildConfirm, setRebuildConfirm] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildState, setRebuildState] = useState<{ message: string; error?: string } | null>(
    null
  );
  const runRebuild = () => {
    setRebuildConfirm(false);
    setRebuilding(true);
    setRebuildState(null);
    void useVaultStore
      .getState()
      .rebuildInternalLinks()
      .then((r) =>
        setRebuildState({
          message: `已扫描 ${r.scanned} 个文件，更新 ${r.modified} 个文件、${r.links} 处链接`,
        })
      )
      .catch((e) => setRebuildState({ message: "", error: `重建失败：${String(e)}` }))
      .finally(() => setRebuilding(false));
  };
  const theme = useSettingsStore((s) => s.theme);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const setVaultModel = useSettingsStore((s) => s.setVaultModel);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setExcludeFolders = useSettingsStore((s) => s.setExcludeFolders);
  const setAttachmentFolder = useSettingsStore((s) => s.setAttachmentFolder);
  const setSoftLineBreak = useSettingsStore((s) => s.setSoftLineBreak);
  const setAutoRestoreFiles = useSettingsStore((s) => s.setAutoRestoreFiles);
  const autoUpdate = useAppStore((s) => s.autoUpdate);
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  const setSyncKeys = useSettingsStore((s) => s.setSyncKeys);
  const setAutoNamingEnabled = useSettingsStore((s) => s.setAutoNamingEnabled);
  const setAutoNamingModel = useSettingsStore((s) => s.setAutoNamingModel);
  /** 宽松换行：缺省开启（单个换行渲染为换行）。 */
  const softLineBreak = vaultConfig?.softLineBreak ?? true;
  /** 话题自动命名：缺省不启用（下拉「不启用」项）。 */
  const autoNamingEnabled = vaultConfig?.autoNamingEnabled ?? false;
  /** 话题自动命名模型（缺省 = 跟随默认模型）。 */
  const autoNamingModelValue = vaultConfig?.autoNamingModel?.model ?? "";

  // 排除文件夹/附件文件夹用本地草稿 + blur 提交（与字号同模式：避免每键一次 IPC）
  const [excludeDraft, setExcludeDraft] = useState(
    vaultConfig?.excludeFolders?.join(", ") ?? "",
  );
  useEffect(() => {
    setExcludeDraft(vaultConfig?.excludeFolders?.join(", ") ?? "");
  }, [vaultConfig?.excludeFolders]);
  const commitExcludeFolders = () => {
    const list = excludeDraft
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    void setExcludeFolders(list);
  };
  const [attachmentDraft, setAttachmentDraft] = useState(
    vaultConfig?.attachmentFolder ?? "",
  );
  useEffect(() => {
    setAttachmentDraft(vaultConfig?.attachmentFolder ?? "");
  }, [vaultConfig?.attachmentFolder]);
  const commitAttachmentFolder = () => {
    const v = attachmentDraft.trim();
    void setAttachmentFolder(v || undefined);
  };

  // 字号用本地草稿 + blur 提交：受控 + 范围校验会拒绝输入中间态（如敲 "1" 准备输 15）导致无法输入
  const [fontSizeDraft, setFontSizeDraft] = useState(
    fontSize !== undefined ? String(fontSize) : "",
  );
  useEffect(() => {
    setFontSizeDraft(fontSize !== undefined ? String(fontSize) : "");
  }, [fontSize]);

  /** blur/Enter 提交字号；非法值回滚为当前配置值。 */
  const commitFontSize = () => {
    const v = fontSizeDraft.trim();
    if (v === "") {
      void setFontSize(undefined);
      return;
    }
    const n = parseFloat(v);
    if (!isNaN(n) && n >= 12 && n <= 20) {
      void setFontSize(n);
    } else {
      setFontSizeDraft(fontSize !== undefined ? String(fontSize) : "");
    }
  };

  const config = useSettingsStore((s) => s.config);
  // 仓库默认模型选项：仓库内已配置供应商的全部模型去重；存量值（供应商被删/改模型）兼容展示
  const modelOptions = Array.from(
    new Set(config.providers.flatMap((p) => p.models.map((m) => m.id))),
  );
  const staleModel =
    vaultConfig?.model !== undefined &&
    vaultConfig.model !== "" &&
    !modelOptions.includes(vaultConfig.model);
  const modelChoices =
    staleModel && vaultConfig?.model
      ? [vaultConfig.model, ...modelOptions]
      : modelOptions;
  /** 话题自动命名模型下拉选项：与默认模型同源（去重 model 列表 + 存量值兼容展示）。 */
  const autoNamingChoices =
    autoNamingModelValue && !modelOptions.includes(autoNamingModelValue)
      ? [autoNamingModelValue, ...modelOptions]
      : modelOptions;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="rounded-lg w-[840px] h-[80vh] flex flex-col border shadow-2xl"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <h2
            className="font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            设置
          </h2>
          <button
            onClick={onClose}
            style={{ color: "var(--text-muted)" }}
            className="hover:opacity-80"
          >
            <X size={14} />
          </button>
        </header>

        {/* 左侧 tab 栏（可折叠）+ 右侧内容区 */}
        <div className="flex flex-1 overflow-hidden">
          <aside
            className={`flex flex-col border-r shrink-0 transition-[width] ${tabsCollapsed ? "w-11" : "w-40"}`}
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {TAB_ITEMS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  title={item.label}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded text-sm transition ${
                    tabsCollapsed ? "justify-center px-0" : ""
                  } ${
                    tab === item.key
                      ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--hover)]"
                  }`}
                >
                  <item.icon size={14} className="shrink-0" />
                  {!tabsCollapsed && (
                    <span className="truncate">{item.label}</span>
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={() => setTabsCollapsed((v) => !v)}
              title={tabsCollapsed ? "展开标签栏" : "折叠标签栏"}
              className={`m-2 flex items-center gap-1 rounded px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--hover)] ${
                tabsCollapsed ? "justify-center" : ""
              }`}
            >
              {tabsCollapsed ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronLeft size={14} />
              )}
              {!tabsCollapsed && "折叠"}
            </button>
          </aside>
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {tab === "general" ? (
              /* ===== 通用面板 ===== */
              <section className="flex-1 p-5 overflow-auto space-y-4">
                {/* 主题模式（应用级，跨仓库共享） */}
                <SettingCard
                  title="主题模式"
                  description="浅色 / 深色 / 跟随系统"
                >
                  <button
                    onClick={toggleTheme}
                    title="切换主题模式（浅色 → 深色 → 跟随系统）"
                    className="relative w-11 h-6 rounded-full transition-colors"
                    style={{
                      background:
                        theme === "dark"
                          ? "var(--accent)"
                          : theme === "system"
                            ? "#64748b"
                            : "#cbd5e1",
                    }}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
                      style={{
                        transform:
                          theme === "dark"
                            ? "translateX(20px)"
                            : theme === "system"
                              ? "translateX(10px)"
                              : "translateX(0)",
                      }}
                    />
                  </button>
                </SettingCard>

                {/* 强调色（应用级）：预设色板 + 取色器 + 恢复默认；空值 = 默认金色 */}
                <SettingCard
                  title="强调色"
                  description="界面强调色（按钮 / 选中高亮 / 画布箭头）"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      {ACCENT_PRESETS.map((c) => {
                        const active = accentColor?.toLowerCase() === c;
                        return (
                          <button
                            key={c}
                            onClick={() => {
                              setAccentDraft(c);
                              void setAccentColor(c);
                            }}
                            title={`强调色 ${c}`}
                            className="w-5 h-5 rounded-full flex items-center justify-center transition hover:scale-110 flex-shrink-0"
                            style={{ background: c }}
                          >
                            {active && <Check size={11} style={{ color: foregroundFor(c) }} />}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      type="color"
                      value={accentDraft}
                      onChange={(e) => commitAccentDraft(e.target.value)}
                      title="自定义颜色"
                      className="w-6 h-6 rounded cursor-pointer bg-transparent p-0 border-0"
                    />
                    <button
                      onClick={() => {
                        setAccentDraft(DEFAULT_ACCENT);
                        void setAccentColor(undefined);
                      }}
                      title="恢复默认金色"
                      className="flex items-center gap-1 text-xs rounded px-1.5 py-1 hover:bg-[var(--hover)] flex-shrink-0"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <RotateCcw size={12} />
                      恢复默认
                    </button>
                  </div>
                </SettingCard>

                {/* 字体大小（应用级） */}
                <SettingCard
                  title="字体大小"
                  description="界面字号；留空 = 18"
                >
                  <input
                    type="number"
                    min={12}
                    max={20}
                    step={1}
                    value={fontSizeDraft}
                    onChange={(e) => setFontSizeDraft(e.target.value)}
                    onBlur={commitFontSize}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    placeholder="18"
                    className="text-sm rounded px-2 py-1 outline-none max-w-[90px]"
                    style={{
                      color: "var(--text-primary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </SettingCard>

                {/* 字体（应用级） */}
                <SettingCard title="字体" description="界面字体">
                  <DropdownSelect
                    value={fontFamily ?? ""}
                    onChange={(v) => void setFontFamily(v || undefined)}
                    options={FONT_OPTIONS}
                    className="text-sm rounded px-2 py-1 max-w-[220px]"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </SettingCard>

                {/* 自动恢复上次打开的文件（应用级）：进入仓库时恢复上次打开的画布/笔记窗口 */}
                <SettingCard
                  title="自动恢复上次打开的文件"
                  description="进入仓库时恢复上次打开的文件"
                >
                  <ToggleSwitch
                    checked={autoRestoreFiles}
                    onChange={(v) => void setAutoRestoreFiles(v)}
                    title="自动恢复上次打开的文件"
                  />
                </SettingCard>

                {/* 自动更新（应用级，global.json）：开启后启动时静默检查新版本并自动安装 */}
                <SettingCard
                  title="自动更新"
                  description="启动时自动检查新版本并安装；关闭 = 不联网检查"
                >
                  <ToggleSwitch
                    checked={autoUpdate}
                    onChange={(v) => void setAutoUpdate(v)}
                    title="自动更新"
                  />
                </SettingCard>

                {/* API key 随仓库保存（仓库级）：开 = key 明文随 config.json 同步多设备；关 = 仅存本机钥匙串 */}
                <SettingCard
                  title="API key 随仓库保存"
                  description="key 随仓库同步共用；仓库公开/共享时可能泄露"
                >
                  <ToggleSwitch
                    checked={!!vaultConfig?.syncKeys}
                    onChange={(v) => void setSyncKeys(v)}
                    title="API key 随仓库保存"
                  />
                </SettingCard>
              </section>
            ) : tab === "providers" ? (
              /* ===== 模型供应商：仓库级供应商管理（多模型 + 测试连通性） ===== */
              <ProviderSettingsSection />
            ) : tab === "modelServices" ? (
              /* ===== 模型服务：各功能使用的模型默认设置（目前仅对话已实现，其余占位） ===== */
              <section className="flex-1 p-5 overflow-auto space-y-4">
                {/* 默认模型（已实现）：仓库级默认模型，存 .atelyx/config.json */}
                <div
                  className="flex items-center justify-between p-3 rounded-lg border gap-3"
                  style={{
                    background: "var(--bg-primary)",
                    borderColor: "var(--border)",
                  }}
                >
                  <div>
                    <div
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      默认模型
                    </div>
                    <div
                      className="text-xs mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      未指定时的默认模型；留空 = 未指定（对话需手动选择模型）
                    </div>
                  </div>
                  <DropdownSelect
                    value={vaultConfig?.model ?? ""}
                    onChange={(v) => setVaultModel(v || null)}
                    options={[
                      { value: "", label: "不指定" },
                      ...modelChoices.map((m) => ({
                        value: m,
                        label: modelNameAcrossProviders(config.providers, m),
                      })),
                    ]}
                    className="text-sm rounded px-2 py-1 w-[200px] flex-shrink-0"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </div>

                {/* 话题自动命名：下拉选择（不启用 / 跟随默认模型 / 指定模型；话题命名一般用小模型） */}
                <div
                  className="flex items-center justify-between p-3 rounded-lg border gap-3"
                  style={{
                    background: "var(--bg-primary)",
                    borderColor: "var(--border)",
                  }}
                >
                  <div>
                    <div
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      话题自动命名
                    </div>
                    <div
                      className="text-xs mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      首轮对话后自动生成简短标题；「不启用」= 关闭自动命名
                    </div>
                  </div>
                  <DropdownSelect
                    value={autoNamingEnabled ? autoNamingModelValue || AUTO_NAMING_DEFAULT : ""}
                    onChange={(v) => {
                      if (!v) {
                        void setAutoNamingEnabled(false);
                        return;
                      }
                      if (v === AUTO_NAMING_DEFAULT) {
                        void setAutoNamingEnabled(true).then(() =>
                          setAutoNamingModel(null),
                        );
                        return;
                      }
                      // 存量值（供应商被删/改模型）选不到 → 清空回退跟随默认模型
                      const p = config.providers.find((x) =>
                        x.models.some((mm) => mm.id === v),
                      );
                      void setAutoNamingEnabled(true).then(() =>
                        setAutoNamingModel(
                          p ? { providerId: p.id, model: v } : null,
                        ),
                      );
                    }}
                    options={[
                      { value: "", label: "不启用" },
                      { value: AUTO_NAMING_DEFAULT, label: "跟随默认模型" },
                      ...autoNamingChoices.map((m) => ({
                        value: m,
                        label: modelNameAcrossProviders(config.providers, m),
                      })),
                    ]}
                    className="text-sm rounded px-2 py-1 w-[200px] flex-shrink-0"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </div>

                {/* 输入建议（未实现，占位） */}
                <div
                  className="flex items-center justify-between p-3 rounded-lg border gap-3 opacity-60"
                  style={{
                    background: "var(--bg-primary)",
                    borderColor: "var(--border)",
                  }}
                >
                  <div>
                    <div
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      输入建议
                    </div>
                    <div
                      className="text-xs mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      输入时的 AI 建议；未实现
                    </div>
                  </div>
                  <DropdownSelect
                    disabled
                    value=""
                    onChange={() => undefined}
                    options={[]}
                    placeholder="未实现"
                    className="text-sm rounded px-2 py-1 w-[200px] flex-shrink-0"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </div>
              </section>
            ) : tab === "search" ? (
              /* ===== 联网搜索面板（仓库级） ===== */
              <SearchConfigSection />
            ) : tab === "files" ? (
              /* ===== 文件与路径面板（仓库级） ===== */
              <section className="flex-1 p-5 overflow-auto space-y-4">
                {/* 排除文件夹：逗号分隔；不显示在文件面板、不参与监听 */}
                <SettingCard
                  title="排除文件夹"
                  description="不显示在文件面板、不参与监听；修改后重开仓库生效"
                >
                  <input
                    value={excludeDraft}
                    onChange={(e) => setExcludeDraft(e.target.value)}
                    onBlur={commitExcludeFolders}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                    }}
                    placeholder="如：Archive, templates"
                    className="w-[260px] text-sm rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </SettingCard>
                {/* 附件文件夹：粘贴 / 拖入的附件导入到此文件夹（留空 = 根目录） */}
                <SettingCard
                  title="附件文件夹"
                  description="粘贴 / 拖入的附件导入到此文件夹；修改后重开仓库生效"
                >
                  <input
                    value={attachmentDraft}
                    onChange={(e) => setAttachmentDraft(e.target.value)}
                    onBlur={commitAttachmentFolder}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                    }}
                    placeholder="如：assets 或 素材/图片"
                    className="w-[260px] text-sm rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    style={{
                      color: "var(--text-secondary)",
                      background: "var(--input-bg)",
                      border: "1px solid var(--input-border)",
                    }}
                  />
                </SettingCard>
              </section>
            ) : tab === "about" ? (
              /* ===== 关于面板：Logo + 版本号 + 检查更新 ===== */
              <AboutSection />
            ) : (
              /* ===== 编辑器面板（仓库级） ===== */
              <section className="flex-1 p-5 overflow-auto space-y-4">
                {/* 宽松换行：仅渲染层生效，编辑模式始终原文 */}
                <SettingCard
                  title="宽松换行"
                  description="单个换行显示为换行；关闭 = 按 Markdown 标准需空行换行"
                >
                  <ToggleSwitch
                    checked={softLineBreak}
                    onChange={(v) => void setSoftLineBreak(v)}
                    title="宽松换行"
                  />
                </SettingCard>

                {/* 内部链接：一键重建为标准 Markdown 写法（批量改写，需确认） */}
                <SettingCard
                  title="内部链接"
                  description={
                    <span>
                  一键统一全仓库笔记的链接为标准 Markdown 写法；批量改写不可撤销。
                      {rebuilding && <span className="block mt-1">重建中…</span>}
                      {rebuildState && (
                        <span
                          className="block mt-1"
                          style={{
                            color: rebuildState.error
                              ? "#f87171"
                              : undefined,
                          }}
                        >
                          {rebuildState.error ?? rebuildState.message}
                        </span>
                      )}
                    </span>
                  }
                >
                  <button
                    className="px-3 py-1.5 text-xs rounded border flex-shrink-0 hover:opacity-80 disabled:opacity-50"
                    style={{
                      borderColor: "#f87171",
                      color: "#f87171",
                    }}
                    disabled={rebuilding}
                    onClick={() => setRebuildConfirm(true)}
                    title="批量改写仓库内全部 .md 的链接写法"
                  >
                    重建内部链接
                  </button>
                </SettingCard>
              </section>
            )}
          </div>
        </div>
      </div>
      {rebuildConfirm && (
        <ConfirmDialog
          title="重建内部链接"
          description="将批量改写仓库内全部 .md 笔记的链接写法，统一为标准 Markdown「[名](基于仓库的路径)」。此操作不可撤销，建议先确认重要笔记已备份！"
          confirmText="开始重建"
          onConfirm={runRebuild}
          onCancel={() => setRebuildConfirm(false)}
        />
      )}
    </div>
  );
}

function SearchConfigSection() {
  const searchConfig = useSettingsStore((s) => s.searchConfig);
  const tavilyKey = useSettingsStore((s) => s.tavilyKey);
  const setSearchConfig = useSettingsStore((s) => s.setSearchConfig);
  const setTavilyKey = useSettingsStore((s) => s.setTavilyKey);
  // Tavily key 用本地草稿 + blur 提交（受控输入避免每键一次 keychain 写入）
  const [keyDraft, setKeyDraft] = useState(tavilyKey);
  useEffect(() => setKeyDraft(tavilyKey), [tavilyKey]);

  return (
    <section className="flex-1 p-5 overflow-auto space-y-4">
      {/* 搜索服务：AI 联网搜索使用的服务商 */}
      <SettingCard title="搜索服务" description="AI 联网搜索使用的服务商">
        <DropdownSelect
          value={searchConfig.provider}
          onChange={(v) =>
            void setSearchConfig({
              provider: v as "tavily" | "searxng",
            })
          }
          options={[
            { value: "tavily", label: "Tavily API" },
            { value: "searxng", label: "SearXNG 自建实例" },
          ]}
          className="text-sm rounded px-2 py-1"
          style={{
            color: "var(--text-primary)",
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
          }}
        />
      </SettingCard>
      {searchConfig.provider === "tavily" ? (
        <SettingCard
          title="Tavily API Key"
          description="默认存本机钥匙串，不进仓库文件"
        >
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={() => void setTavilyKey(keyDraft.trim())}
            placeholder="tvly-..."
            className="text-sm rounded px-2 py-1 outline-none w-[260px]"
            style={{
              color: "var(--text-primary)",
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
            }}
          />
        </SettingCard>
      ) : (
        <SettingCard title="SearXNG URL" description="自建实例的访问地址">
          <input
            type="url"
            value={searchConfig.searxngUrl}
            onChange={(e) =>
              void setSearchConfig({ searxngUrl: e.target.value })
            }
            placeholder="https://searx.example.com"
            className="text-sm rounded px-2 py-1 outline-none w-[260px]"
            style={{
              color: "var(--text-primary)",
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
            }}
          />
        </SettingCard>
      )}
    </section>
  );
}

/** 设置项卡片（设置页统一样式基准）：左侧标题 + 描述，右侧控件；align 控制行对齐（输入类居中 / 开关类顶对齐）。 */
function SettingCard({
  title,
  description,
  align = "center",
  children,
}: {
  title: string;
  description: React.ReactNode;
  align?: "center" | "start";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-${align === "start" ? "start" : "center"} justify-between p-3 rounded-lg border gap-3`}
      style={{
        background: "var(--bg-primary)",
        borderColor: "var(--border)",
      }}
    >
      <div className="min-w-0">
        <div
          className="text-sm font-medium"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </div>
        <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {description}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
