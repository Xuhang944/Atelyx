/**
 * 插件清单校验与兼容性纯函数测试（utils/pluginManifest）。
 *
 * 覆盖：id 合法性、版本比较、宿主兼容（版本范围/平台）、清单校验的必填/可选/归一化、
 * 前向兼容（未知类型/能力名/附加分类跳过）、敏感能力判定。
 */
import { describe, it, expect } from "vitest";
import {
  checkPluginCapability,
  compareVersions,
  isKnownCapability,
  isSensitiveCapability,
  pluginCompatibleWithHost,
  pluginIdValid,
  pluginTypeList,
  validatePluginManifest,
  validateSuiteManifest,
} from "./pluginManifest";
import type { PluginManifest } from "@/types";

const validManifest = (): Record<string, unknown> => ({
  schemaVersion: 1,
  id: "com.example.todo",
  name: "示例插件",
  version: "1.2.3",
  type: "tool",
  main: "plugin.js",
});

describe("pluginIdValid", () => {
  it("接受反向域名式 id", () => {
    expect(pluginIdValid("com.example.todo")).toBe(true);
    expect(pluginIdValid("a.b")).toBe(true);
    expect(pluginIdValid("io.github.user.plugin-1")).toBe(true);
  });
  it("拒绝非法 id", () => {
    expect(pluginIdValid("todo")).toBe(false); // 单段
    expect(pluginIdValid("com..example")).toBe(false); // 连续点
    expect(pluginIdValid(".com.example")).toBe(false); // 点开头
    expect(pluginIdValid("com.example.")).toBe(false); // 点结尾
    expect(pluginIdValid("com.example-")).toBe(false); // 段以中划线结尾
    expect(pluginIdValid("COM.Example")).toBe(false); // 大写
  });
});

describe("compareVersions", () => {
  it("按段比较", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  });
  it("容忍缺段与非数字段", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
    expect(compareVersions("0.3.7-beta", "0.3.7")).toBe(0); // 非数字段按 0
  });
});

describe("pluginCompatibleWithHost", () => {
  const base = { atelyxVersionMin: undefined, atelyxVersionMax: undefined, platforms: undefined };
  it("无约束时兼容", () => {
    expect(pluginCompatibleWithHost(base, "0.4.0", "windows-x64").ok).toBe(true);
  });
  it("版本下限/上限", () => {
    expect(pluginCompatibleWithHost({ ...base, atelyxVersionMin: "0.4.0" }, "0.3.7", "windows-x64").ok).toBe(false);
    expect(pluginCompatibleWithHost({ ...base, atelyxVersionMin: "0.4.0" }, "0.4.0", "windows-x64").ok).toBe(true);
    expect(pluginCompatibleWithHost({ ...base, atelyxVersionMax: "0.5.0" }, "0.5.0", "windows-x64").ok).toBe(false);
    expect(pluginCompatibleWithHost({ ...base, atelyxVersionMax: "0.5.0" }, "0.4.9", "windows-x64").ok).toBe(true);
  });
  it("平台过滤", () => {
    expect(pluginCompatibleWithHost({ ...base, platforms: ["linux-x64"] }, "0.4.0", "windows-x64").ok).toBe(false);
    expect(pluginCompatibleWithHost({ ...base, platforms: ["windows-x64", "linux-x64"] }, "0.4.0", "windows-x64").ok).toBe(true);
  });
});

describe("validatePluginManifest", () => {
  it("接受合法清单并归一化缺省值", () => {
    const result = validatePluginManifest(validManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.scope).toBe("app");
    expect(result.manifest.types).toEqual(["tool"]);
    expect(result.manifest.uses).toBeUndefined(); // 未声明 uses 时缺省省略
  });
  it("拒绝结构错误", () => {
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), id: "todo" }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), name: "" }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), type: "watcher" }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), main: "" }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), schemaVersion: 2 }).ok).toBe(false); // 版本过新
  });
  it("前向兼容：未知附加分类/能力名/uses 跳过而不报错", () => {
    const result = validatePluginManifest({
      ...validManifest(),
      type: "tool",
      types: ["tool", "future-kind"],
      uses: ["vault:read", "future:cap"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.types).toEqual(["tool"]);
    expect(result.manifest.uses).toEqual(["vault:read"]);
  });
  it("保留 uses/permissions/platforms 并校验类型", () => {
    const result = validatePluginManifest({
      ...validManifest(),
      scope: "vault",
      uses: ["vault:read", "keychain:read"],
      permissions: { "vault:read": "读取笔记文件" },
      platforms: ["windows-x64"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.scope).toBe("vault");
    expect(result.manifest.uses).toEqual(["vault:read", "keychain:read"]);
    expect(result.manifest.permissions).toEqual({ "vault:read": "读取笔记文件" });
    expect(result.manifest.platforms).toEqual(["windows-x64"]);
  });
  it("theme 声明式皮肤解析与结构校验", () => {
    const ok = validatePluginManifest({
      ...validManifest(),
      type: "theme",
      theme: { variables: { "--accent": "#7c3aed", bg: "#111" }, dark: { "--bg": "#000" } },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.theme?.variables).toEqual({ "--accent": "#7c3aed", bg: "#111" });
    expect(ok.manifest.theme?.dark).toEqual({ "--bg": "#000" });

    expect(validatePluginManifest({ ...validManifest(), theme: { variables: "x" } }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), theme: [] }).ok).toBe(false);
    expect(validatePluginManifest({ ...validManifest(), theme: { dark: "x" } }).ok).toBe(false);
  });
});

describe("能力判定", () => {
  it("敏感能力名单", () => {
    expect(isSensitiveCapability("keychain:read")).toBe(true);
    expect(isSensitiveCapability("shell")).toBe(true);
    expect(isSensitiveCapability("vault:delete")).toBe(true);
    expect(isSensitiveCapability("vault:read")).toBe(false);
  });
  it("未知能力名不破坏前向兼容", () => {
    expect(isKnownCapability("vault:read")).toBe(true);
    expect(isKnownCapability("future:cap")).toBe(false);
  });
});

describe("checkPluginCapability（桥门槛）", () => {
  const declared = (uses: PluginManifest["uses"]): Pick<PluginManifest, "uses"> => ({ uses });
  it("敏感能力未声明即拒绝", () => {
    expect(checkPluginCapability(declared([]), "keychain:read").ok).toBe(false);
    expect(checkPluginCapability(declared(["vault:read"]), "shell").ok).toBe(false);
  });
  it("敏感能力已声明即可用", () => {
    expect(checkPluginCapability(declared(["keychain:read"]), "keychain:read").ok).toBe(true);
  });
  it("非敏感能力放行", () => {
    expect(checkPluginCapability(declared(undefined), "vault:read").ok).toBe(true);
    expect(checkPluginCapability(declared(undefined), "ai:chat").ok).toBe(true);
  });
  it("未知能力名放行（前向兼容）", () => {
    expect(checkPluginCapability(declared(undefined), "future:cap").ok).toBe(true);
  });
});

describe("pluginTypeList", () => {
  it("含主分类去重", () => {
    expect(pluginTypeList({ type: "tool", types: ["tool", "panel"] })).toEqual(["tool", "panel"]);
    expect(pluginTypeList({ type: "theme", types: undefined })).toEqual(["theme"]);
  });
});

describe("validateSuiteManifest", () => {
  const validSuite = (): Record<string, unknown> => ({
    schemaVersion: 1,
    id: "com.example.starter",
    name: "入门套件",
    version: "1.0.0",
    plugins: ["com.example.todo"],
  });
  it("接受合法套件并保留 themeId", () => {
    const r = validateSuiteManifest({
      ...validSuite(),
      themeId: "com.example.dark",
      plugins: ["com.example.todo", "com.example.cal"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suite.plugins).toEqual(["com.example.todo", "com.example.cal"]);
    expect(r.suite.themeId).toBe("com.example.dark");
  });
  it("拒绝结构错误", () => {
    expect(validateSuiteManifest(null).ok).toBe(false);
    expect(validateSuiteManifest(validSuite()).ok).toBe(true);
    expect(validateSuiteManifest({ ...validSuite(), plugins: [] }).ok).toBe(false);
    expect(validateSuiteManifest({ ...validSuite(), plugins: ["bad"] }).ok).toBe(false);
    expect(validateSuiteManifest({ ...validSuite(), plugins: [{ id: "com.x" }] }).ok).toBe(false);
    expect(validateSuiteManifest({ ...validSuite(), schemaVersion: 2 }).ok).toBe(false);
  });
});

describe("theme 免 main（纯主题插件无需入口）", () => {
  it("纯 theme 插件可省略 main", () => {
    const r = validatePluginManifest({
      schemaVersion: 1,
      id: "com.example.dark",
      name: "暗色皮肤",
      version: "1.0.0",
      type: "theme",
      theme: { variables: { bg: "#000" } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.main).toBeUndefined();
    expect(r.manifest.theme?.variables).toEqual({ bg: "#000" });
  });
  it("非 theme（tool）插件缺 main 拒绝", () => {
    expect(validatePluginManifest({ ...validManifest(), main: undefined }).ok).toBe(false);
  });
  it("混合类型（含非 theme）插件缺 main 拒绝", () => {
    const r = validatePluginManifest({
      ...validManifest(),
      main: undefined,
      type: "theme",
      types: ["theme", "tool"],
      theme: { variables: { bg: "#000" } },
    });
    expect(r.ok).toBe(false);
  });
});
