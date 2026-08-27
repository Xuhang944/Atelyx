import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  Info,
  PenLine,
  Search,
  Server,
  Settings,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import { useVaultStore } from "@/stores/vaultStore";
import {
  useCollabStore,
  normalizeRelayUrl,
  type RelayTestResult,
} from "@/stores/collabStore";
import { useDraftSync, useDebouncedDraft } from "@/hooks/useDraftSync";
import { ProviderSettingsSection } from "@/components/settings/ProviderSettingsSection";
import { AgentSettingsSection } from "@/components/settings/AgentSettingsSection";
import { AboutSection } from "@/components/settings/AboutSection";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { GeneralSettingsTab } from "@/components/settings/tabs/GeneralSettingsTab";
import { CollabSettingsTab } from "@/components/settings/tabs/CollabSettingsTab";
import { ModelServicesSettingsTab } from "@/components/settings/tabs/ModelServicesSettingsTab";
import { FilesSettingsTab } from "@/components/settings/tabs/FilesSettingsTab";
import { EditorSettingsTab } from "@/components/settings/tabs/EditorSettingsTab";
import { SearchSettingsTab } from "@/components/settings/tabs/SearchSettingsTab";
import { DEFAULT_ACCENT } from "@/utils/color";

type Tab =
  | "general"
  | "collab"
  | "providers"
  | "modelServices"
  | "agents"
  | "search"
  | "files"
  | "editor"
  | "about";

/** 左侧 tab 栏配置（图标 + 标签；折叠后仅显示图标）。 */
const TAB_ITEMS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "general", label: "通用", icon: Settings },
  { key: "collab", label: "多人协作", icon: Users },
  { key: "providers", label: "模型供应商", icon: Server },
  { key: "modelServices", label: "模型服务", icon: Bot },
  { key: "agents", label: "Agent", icon: Sparkles },
  { key: "search", label: "联网搜索", icon: Search },
  { key: "files", label: "文件与路径", icon: FolderTree },
  { key: "editor", label: "编辑器", icon: PenLine },
  { key: "about", label: "关于", icon: Info },
];

export function SettingsModal({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const vaultConfig = useSettingsStore((s) => s.vaultConfig);
  // 应用级外观（跨仓库共享，global.json）：强调色 / 字号 / 字体 / 自动恢复
  const accentColor = useSettingsStore((s) => s.accentColor);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const autoRestoreFiles = useSettingsStore((s) => s.autoRestoreFiles);
  const defaultHomeLayout = useSettingsStore((s) => s.defaultHomeLayout);
  const setDefaultHomeLayout = useSettingsStore((s) => s.setDefaultHomeLayout);
  // 协作中转（应用级）：开关 + 地址 + 昵称/颜色 + 连接状态
  const collabEnabled = useSettingsStore((s) => s.collabEnabled);
  const collabRelayUrl = useSettingsStore((s) => s.collabRelayUrl);
  const collabNickname = useSettingsStore((s) => s.collabNickname);
  const collabColor = useSettingsStore((s) => s.collabColor);
  const setCollabConfig = useSettingsStore((s) => s.setCollabConfig);
  const collabConnected = useCollabStore((s) => s.connected);
  // 设置内容（左侧九 tab）：应用级（通用 / 多人协作 / 关于）+ 仓库级（模型供应商 / 模型服务 / Agent / 联网搜索 / 文件与路径 / 编辑器）
  const [tab, setTab] = useState<Tab>(() =>
    initialTab && TAB_ITEMS.some((t) => t.key === (initialTab as Tab)) ? (initialTab as Tab) : "general",
  );
  /** 左侧 tab 栏折叠状态（折叠后仅显示图标）。 */
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  /** 检查中转连接：执行中 / 结果（多人协作 tab）。 */
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RelayTestResult | null>(null);
  const runConnectionTest = async () => {
    // 先提交草稿地址（使已测试的地址即保存的配置），再一次性探测 relay（独立连接，不影响常驻）
    commitRelayUrl();
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await useCollabStore.getState().testConnection(relayUrlDraft));
    } finally {
      setTesting(false);
    }
  };
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
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setExcludeFolders = useSettingsStore((s) => s.setExcludeFolders);
  const setAttachmentFolder = useSettingsStore((s) => s.setAttachmentFolder);
  const setSoftLineBreak = useSettingsStore((s) => s.setSoftLineBreak);
  const setAutoRestoreFiles = useSettingsStore((s) => s.setAutoRestoreFiles);
  const autoUpdate = useAppStore((s) => s.autoUpdate);
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  const setSyncKeys = useSettingsStore((s) => s.setSyncKeys);
  // 强调色/协作色取色器草稿：拖动连续 onChange，防抖 200ms 后落盘（避免每帧一次配置原子写/relay 重连）
  const [accentDraft, commitAccentDraft] = useDebouncedDraft(
    accentColor ?? DEFAULT_ACCENT,
    (v) => void setAccentColor(v),
  );
  /** 宽松换行：缺省开启（单个换行渲染为换行）。 */
  const softLineBreak = vaultConfig?.softLineBreak ?? true;

  // 排除文件夹/附件文件夹用本地草稿 + blur 提交（与字号同模式：避免每键一次 IPC）
  const [excludeDraft, setExcludeDraft] = useDraftSync(
    vaultConfig?.excludeFolders?.join(", ") ?? "",
  );
  const commitExcludeFolders = () => {
    const list = excludeDraft
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    void setExcludeFolders(list);
  };
  const [attachmentDraft, setAttachmentDraft] = useDraftSync(
    vaultConfig?.attachmentFolder ?? "",
  );
  const commitAttachmentFolder = () => {
    const v = attachmentDraft.trim();
    void setAttachmentFolder(v || undefined);
  };

  // 字号用本地草稿 + blur 提交：受控 + 范围校验会拒绝输入中间态（如敲 "1" 准备输 15）导致无法输入
  const [fontSizeDraft, setFontSizeDraft] = useDraftSync(
    fontSize !== undefined ? String(fontSize) : "",
  );

  /** blur/Enter 提交字号；非法值回滚为当前配置值。 */
  const commitFontSize = () => {
    const v = fontSizeDraft.trim();
    if (v === "") {
      void setFontSize(undefined);
      return;
    }
    const n = Number(v);
    if (n >= 12 && n <= 20) {
      void setFontSize(n);
    } else {
      setFontSizeDraft(fontSize !== undefined ? String(fontSize) : ""); // 非法值回滚
    }
  };

  // 协作地址/昵称草稿（blur/Enter 提交，避免每键一次 IPC）
  const [relayUrlDraft, setRelayUrlDraft] = useDraftSync(collabRelayUrl);
  const commitRelayUrl = () => {
    // 只输 host:port 也能用：自动补全 ws:// 与 /ws 后存盘
    void setCollabConfig({ collabRelayUrl: normalizeRelayUrl(relayUrlDraft) });
  };
  const [collabNicknameDraft, setCollabNicknameDraft] = useDraftSync(collabNickname);
  const commitCollabNickname = () => {
    void setCollabConfig({ collabNickname: collabNicknameDraft.trim() });
  };
  // 协作身份色草稿：取色器拖动连续触发 onChange，防抖 200ms 后落盘（同强调色模式）
  const [collabColorDraft, commitCollabColorDraft] = useDebouncedDraft(
    collabColor || "#e06c75",
    (v) => void setCollabConfig({ collabColor: v }),
  );

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
              <GeneralSettingsTab
                theme={theme}
                toggleTheme={toggleTheme}
                accentColor={accentColor}
                accentDraft={accentDraft}
                commitAccentDraft={commitAccentDraft}
                fontSizeDraft={fontSizeDraft}
                setFontSizeDraft={setFontSizeDraft}
                commitFontSize={commitFontSize}
                fontFamily={fontFamily}
                setFontFamily={setFontFamily}
                autoRestoreFiles={autoRestoreFiles}
                setAutoRestoreFiles={setAutoRestoreFiles}
                defaultHomeLayout={defaultHomeLayout}
                setDefaultHomeLayout={setDefaultHomeLayout}
                autoUpdate={autoUpdate}
                setAutoUpdate={setAutoUpdate}
                syncKeys={!!vaultConfig?.syncKeys}
                setSyncKeys={setSyncKeys}
              />
            ) : tab === "collab" ? (
              <CollabSettingsTab
                collabEnabled={collabEnabled}
                setCollabConfig={setCollabConfig}
                collabConnected={collabConnected}
                runConnectionTest={runConnectionTest}
                testing={testing}
                testResult={testResult}
                relayUrlDraft={relayUrlDraft}
                setRelayUrlDraft={setRelayUrlDraft}
                commitRelayUrl={commitRelayUrl}
                collabNicknameDraft={collabNicknameDraft}
                setCollabNicknameDraft={setCollabNicknameDraft}
                commitCollabNickname={commitCollabNickname}
                collabColorDraft={collabColorDraft}
                commitCollabColorDraft={commitCollabColorDraft}
              />
            ) : tab === "providers" ? (
              /* ===== 模型供应商：仓库级供应商管理（多模型 + 测试连通性） ===== */
              <ProviderSettingsSection />
            ) : tab === "modelServices" ? (
              /* ===== 模型服务：各功能使用的模型默认设置（目前仅对话已实现，其余占位） ===== */
              <ModelServicesSettingsTab />
            ) : tab === "agents" ? (
              /* ===== Agent 面板（仓库级）：对话预设（名称 + 系统提示词 + 工具）配置 ===== */
              <AgentSettingsSection />
            ) : tab === "search" ? (
              /* ===== 联网搜索面板（仓库级） ===== */
              <SearchSettingsTab />
            ) : tab === "files" ? (
              /* ===== 文件与路径面板（仓库级） ===== */
              <FilesSettingsTab
                excludeDraft={excludeDraft}
                setExcludeDraft={setExcludeDraft}
                commitExcludeFolders={commitExcludeFolders}
                attachmentDraft={attachmentDraft}
                setAttachmentDraft={setAttachmentDraft}
                commitAttachmentFolder={commitAttachmentFolder}
              />
            ) : tab === "about" ? (
              /* ===== 关于面板：Logo + 版本号 + 检查更新 ===== */
              <AboutSection />
            ) : (
              /* ===== 编辑器面板（仓库级） ===== */
              <EditorSettingsTab
                softLineBreak={softLineBreak}
                setSoftLineBreak={setSoftLineBreak}
                rebuilding={rebuilding}
                rebuildState={rebuildState}
                setRebuildConfirm={setRebuildConfirm}
              />
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
