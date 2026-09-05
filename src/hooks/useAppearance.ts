/**
 * 应用外观应用（主题/字号/字体/强调色 + 系统主题跟随 + 插件主题变量）。
 * 主窗口（App）与撕裂窗口（PanelWindowRoot）共用：撕裂窗口是独立 webview，
 * 需要自行应用同一套外观（settingsStore 应用级配置，两窗口各自读盘）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { usePluginStore } from "@/stores/pluginStore";
import { darkenHex, foregroundFor } from "@/utils/color";
import { pluginThemeVariables } from "@/utils/pluginTheme";

export function useAppearance(): void {
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const accentColor = useSettingsStore((s) => s.accentColor);

  // 跟随系统主题：监听 prefers-color-scheme 变化（theme === "system" 时实时生效）
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effectiveTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  // 主题 class 应用（分层：store 只存状态，DOM 副作用归 hook）
  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
  }, [effectiveTheme]);

  // 字体（应用级）：覆盖 :root font-size / font-family，空值回默认（CSS 默认）
  useEffect(() => {
    const root = document.documentElement;
    root.style.fontSize = fontSize ? `${fontSize}px` : "";
    root.style.fontFamily = fontFamily ?? "";
  }, [fontSize, fontFamily]);

  // 强调色（应用级）：覆盖 --accent 系列变量，空值回默认金色；深/浅主题共用同一份
  // （:root 与 :root.dark 均不单独定义 accent，inline style 优先级最高对两主题同时生效）
  useEffect(() => {
    const root = document.documentElement;
    if (accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor)) {
      root.style.setProperty("--accent", accentColor);
      root.style.setProperty("--accent-hover", darkenHex(accentColor));
      root.style.setProperty("--accent-fg", foregroundFor(accentColor));
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-hover");
      root.style.removeProperty("--accent-fg");
    }
  }, [accentColor]);

  // 插件主题变量（声明式）：启用中的 theme 插件变量叠加到 :root；变更时先移除上一次
  // 设置的变量再应用（插件卸载/停用后不留残留变量）。
  const plugins = usePluginStore((s) => s.plugins);
  const pluginVars = useMemo(
    () => pluginThemeVariables(Object.values(plugins), effectiveTheme),
    [plugins, effectiveTheme],
  );
  const prevPluginVarKeysRef = useRef<string[]>([]);
  useEffect(() => {
    const root = document.documentElement;
    for (const key of prevPluginVarKeysRef.current) root.style.removeProperty(key);
    const keys: string[] = [];
    for (const [key, value] of Object.entries(pluginVars)) {
      root.style.setProperty(key, value);
      keys.push(key);
    }
    prevPluginVarKeysRef.current = keys;
  }, [pluginVars]);
}
