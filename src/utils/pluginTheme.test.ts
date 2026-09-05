/**
 * 插件主题解析测试（utils/pluginTheme）。
 *
 * 覆盖：浅/暗色合并、键前缀归一化、多主题叠加顺序（id 排序后者覆盖）、停用跳过。
 */
import { describe, it, expect } from "vitest";
import { pluginThemeVariables } from "./pluginTheme";
import type { InstalledPlugin, PluginManifest } from "@/types";

type ThemePluginRow = Pick<InstalledPlugin, "id" | "enabled" | "manifest">;

function themePlugin(id: string, vars: Record<string, string>, dark?: Record<string, string>, enabled = true): ThemePluginRow {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    type: "theme",
    main: "plugin.js",
    ...(dark ? { theme: { variables: vars, dark } } : { theme: { variables: vars } }),
  };
  return { id, enabled, manifest };
}

describe("pluginThemeVariables", () => {
  it("浅色模式只合并 variables", () => {
    const out = pluginThemeVariables([themePlugin("com.a.theme", { "--accent": "#7c3aed" })], "light");
    expect(out).toEqual({ "--accent": "#7c3aed" });
  });

  it("暗色模式叠加 dark 覆盖", () => {
    const row = themePlugin("com.a.theme", { "--bg": "#fff" }, { "--bg": "#000" });
    expect(pluginThemeVariables([row], "light")["--bg"]).toBe("#fff");
    expect(pluginThemeVariables([row], "dark")["--bg"]).toBe("#000");
  });

  it("键自动补 -- 前缀", () => {
    const out = pluginThemeVariables([themePlugin("com.a.theme", { accent: "#123456" })], "light");
    expect(out["--accent"]).toBe("#123456");
  });

  it("多主题按 id 排序叠加，后者覆盖前者", () => {
    const rows = [
      themePlugin("com.b.theme", { "--accent": "#bbbbbb" }),
      themePlugin("com.a.theme", { "--accent": "#aaaaaa" }),
    ];
    const out = pluginThemeVariables(rows, "light");
    expect(out["--accent"]).toBe("#bbbbbb"); // com.b 排在 com.a 之后
  });

  it("停用的主题插件跳过", () => {
    const rows = [
      themePlugin("com.a.theme", { "--accent": "#aaaaaa" }, undefined, false),
      themePlugin("com.b.theme", { "--accent": "#bbbbbb" }),
    ];
    expect(pluginThemeVariables(rows, "light")).toEqual({ "--accent": "#bbbbbb" });
  });
});
