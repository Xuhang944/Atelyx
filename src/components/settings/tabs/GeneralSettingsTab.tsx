import { Check, RotateCcw } from "lucide-react";
import { DropdownSelect } from "@/components/common/DropdownSelect";
import { ToggleSwitch } from "@/components/common/ToggleSwitch";
import { SettingCard } from "@/components/settings/SettingCard";
import { DEFAULT_ACCENT, foregroundFor } from "@/utils/color";
import { useSettingsStore } from "@/stores/settingsStore";
import { useAppStore } from "@/stores/appStore";
import { useDraftSync, useDebouncedDraft } from "@/hooks/useDraftSync";

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
/** 强调色预设色板（600/700 阶深色系：白字对比 ≥ 5:1，金色默认由「恢复默认」按钮回归；取色器可自由选色）。 */
const ACCENT_PRESETS = [
  "#2563eb",
  "#0d9488",
  "#7c3aed",
  "#dc2626",
  "#15803d",
];

/** 通用面板（应用级外观 + 仓库级 key 同步开关）：草稿与状态自持，直接订阅 store。 */
export function GeneralSettingsTab() {
  // 应用级外观（跨仓库共享，global.json）：主题 / 强调色 / 字号 / 字体 / 自动恢复 / 主页布局 / 自动更新
  const theme = useSettingsStore((s) => s.theme);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const autoRestoreFiles = useSettingsStore((s) => s.autoRestoreFiles);
  const setAutoRestoreFiles = useSettingsStore((s) => s.setAutoRestoreFiles);
  const defaultHomeLayout = useSettingsStore((s) => s.defaultHomeLayout);
  const setDefaultHomeLayout = useSettingsStore((s) => s.setDefaultHomeLayout);
  const autoUpdate = useAppStore((s) => s.autoUpdate);
  const setAutoUpdate = useAppStore((s) => s.setAutoUpdate);
  // API key 随仓库保存（仓库级）
  const vaultConfig = useSettingsStore((s) => s.vaultConfig);
  const setSyncKeys = useSettingsStore((s) => s.setSyncKeys);
  const syncKeys = !!vaultConfig?.syncKeys;

  // 强调色取色器草稿：拖动连续 onChange，防抖 200ms 后落盘（避免每帧一次配置原子写）
  const [accentDraft, commitAccentDraft] = useDebouncedDraft(
    accentColor ?? DEFAULT_ACCENT,
    (v) => void setAccentColor(v),
  );

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

  return (
    <section className="flex-1 p-5 overflow-auto space-y-4">
      {/* 主题模式（应用级，跨仓库共享） */}
      <SettingCard title="主题模式" description="浅色 / 深色 / 跟随系统">
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
                  onClick={() => commitAccentDraft(c)}
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
            onClick={() => commitAccentDraft(DEFAULT_ACCENT)}
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
      <SettingCard title="字体大小" description="界面字号；留空 = 18">
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

      {/* 进仓库时打开主页（应用级）：开启后进入仓库自动切到主页布局；关闭 = 保持恢复上次界面 */}
      <SettingCard
        title="进仓库时打开主页"
        description="进入仓库自动切到主页布局；关闭则恢复上次界面"
      >
        <ToggleSwitch
          checked={defaultHomeLayout}
          onChange={(v) => void setDefaultHomeLayout(v)}
          title="进仓库时打开主页"
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
          checked={syncKeys}
          onChange={(v) => void setSyncKeys(v)}
          title="API key 随仓库保存"
        />
      </SettingCard>
    </section>
  );
}
