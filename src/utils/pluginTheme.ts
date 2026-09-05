/**
 * 插件主题解析：把已启用的 theme 插件（声明式 CSS 变量）合并成 :root 变量表。
 * 归一化：键补 `--` 前缀（插件可省略）；多个主题插件按 id 排序叠加（后者覆盖前者）。
 * 纯函数，供 useAppearance 消费（DOM 副作用归 hook）。
 */
import type { InstalledPlugin, PluginTheme } from "@/types";

export type EffectiveThemeMode = "dark" | "light";

/** 合并已启用 theme 插件的变量表（浅色变量 + 暗色模式下的 dark 覆盖）。 */
export function pluginThemeVariables(
  plugins: Array<Pick<InstalledPlugin, "id" | "enabled" | "manifest">>,
  mode: EffectiveThemeMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  const themes = plugins
    .filter((p) => p.enabled && p.manifest.theme !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const p of themes) {
    const theme = p.manifest.theme;
    if (!theme) continue;
    mergeVars(out, theme.variables);
    if (mode === "dark" && theme.dark) mergeVars(out, theme.dark);
  }
  return out;
}

function mergeVars(target: Record<string, string>, source: PluginTheme["variables"]): void {
  for (const [key, value] of Object.entries(source)) {
    const k = key.startsWith("--") ? key : `--${key}`;
    target[k] = value;
  }
}
