/**
 * 插件清单校验与兼容性判断。
 * 校验目标是「坏清单不让 App 内部功能出问题」，而不是拒绝一切：未知字段、未知能力名、未知附加
 * 分类一律跳过（前向兼容），只对结构性问题（缺字段、类型错误、格式版本过新）报错。
 */
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_SCHEMA_VERSION,
  SENSITIVE_PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginManifest,
  type PluginScope,
  type PluginTheme,
  type PluginType,
} from "@/types";

export type ManifestValidateResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

/** 已知插件类型（判定的唯一依据；新增类型在 types/plugin.ts 的联合里加）。 */
const KNOWN_PLUGIN_TYPES: readonly string[] = [
  "tool",
  "setting",
  "panel",
  "app",
  "node",
  "theme",
  "command",
  "background",
];

/** 已知能力名集合（uses 校验用；未知能力名跳过不报错）。 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);

const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** id 是否合法：反向域名式（至少两段、小写字母/数字/中划线、段不以中划线收尾）。 */
export function pluginIdValid(id: string): boolean {
  return id.length <= 128 && PLUGIN_ID_PATTERN.test(id);
}

/** 是否为已知插件类型（未知类型在旧 App 上安全跳过）。 */
export function isKnownPluginType(type: string): boolean {
  return KNOWN_PLUGIN_TYPES.includes(type);
}

/** 是否为敏感能力（未声明即运行时拒绝）。 */
export function isSensitiveCapability(cap: string): boolean {
  return (SENSITIVE_PLUGIN_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * 桥能力门槛：敏感能力必须已声明（声明了就能用，不额外弹窗）；非敏感能力放行但计入审计。
 * 未知能力名放行（前向兼容——新能力由新 App 判定，旧插件不会被拒）。
 */
export function checkPluginCapability(
  manifest: Pick<PluginManifest, "uses">,
  cap: string,
): { ok: true } | { ok: false; reason: string } {
  if (isSensitiveCapability(cap)) {
    const declared = manifest.uses ?? [];
    if (!declared.includes(cap as PluginCapability)) {
      return { ok: false, reason: `插件未声明敏感能力：${cap}` };
    }
  }
  return { ok: true };
}

/** 是否为已知能力名（未知能力名用于前向兼容：跳过不报错）。 */
export function isKnownCapability(cap: string): boolean {
  return KNOWN_CAPABILITIES.has(cap);
}

/** 全部分类（含主分类，去重；缺省 = [type]）。 */
export function pluginTypeList(manifest: Pick<PluginManifest, "type" | "types">): PluginType[] {
  return [...new Set([manifest.type, ...(manifest.types ?? [])])];
}

/** UI 类插件类型（主线程平面承载：渲染 React/触达 DOM）。 */
const UI_PLUGIN_TYPES: ReadonlySet<PluginType> = new Set(["panel", "setting", "app", "node"]);

/** worker 平面插件类型（隔离上下文承载：工具/后台/命令逻辑）。 */
const WORKER_PLUGIN_TYPES: ReadonlySet<PluginType> = new Set(["tool", "background", "command"]);

/** 是否 UI 类插件类型（需要主线程平面）。 */
export function isUiPluginType(type: PluginType): boolean {
  return UI_PLUGIN_TYPES.has(type);
}

/** 是否 worker 类插件类型（隔离上下文承载逻辑）。 */
export function isWorkerPluginType(type: PluginType): boolean {
  return WORKER_PLUGIN_TYPES.has(type);
}

/** 语义化版本比较（容忍 1/2/3 段与缺段，非数字段按 0 处理）。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseVersion(value: string): number[] {
  return value.split(".").map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** 插件是否兼容当前宿主（版本范围 + 平台）。 */
export function pluginCompatibleWithHost(
  manifest: Pick<PluginManifest, "atelyxVersionMin" | "atelyxVersionMax" | "platforms">,
  hostVersion: string,
  platform: string,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.atelyxVersionMin && compareVersions(hostVersion, manifest.atelyxVersionMin) < 0) {
    return { ok: false, reason: `需要 Atelyx ${manifest.atelyxVersionMin} 及以上版本` };
  }
  if (manifest.atelyxVersionMax && compareVersions(hostVersion, manifest.atelyxVersionMax) >= 0) {
    return { ok: false, reason: `仅支持 Atelyx ${manifest.atelyxVersionMax} 以下版本` };
  }
  if (manifest.platforms && manifest.platforms.length > 0 && !manifest.platforms.includes(platform)) {
    return { ok: false, reason: `不支持当前平台（${platform}）` };
  }
  return { ok: true };
}

/** 校验并归一化插件清单；结构错误返回原因列表。 */
export function validatePluginManifest(raw: unknown): ManifestValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["清单必须是对象"] };
  const data = raw as Record<string, unknown>;

  const errors: string[] = [];

  const schemaVersion = data.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    errors.push("schemaVersion 必须是正整数");
  } else if (schemaVersion > PLUGIN_SCHEMA_VERSION) {
    errors.push(`清单格式版本过新（${schemaVersion}），需要更新 Atelyx`);
  }

  const id = data.id;
  if (typeof id !== "string" || !pluginIdValid(id)) errors.push("id 必须是合法的反向域名标识");

  const name = data.name;
  if (typeof name !== "string" || name.trim().length === 0) errors.push("name 不能为空");

  const version = data.version;
  if (typeof version !== "string" || version.trim().length === 0) errors.push("version 不能为空");

  const type = data.type;
  if (typeof type !== "string" || !isKnownPluginType(type)) errors.push(`未知插件类型：${String(type)}`);

  const main = data.main;
  if (main !== undefined && (typeof main !== "string" || main.trim().length === 0)) {
    errors.push("main 必须是非空字符串");
  }

  const mainUi = data.mainUi;
  if (mainUi !== undefined && (typeof mainUi !== "string" || mainUi.trim().length === 0)) {
    errors.push("mainUi 必须是非空字符串");
  }

  if (errors.length > 0) return { ok: false, errors };

  const types = normalizeTypes(type as string, data.types, errors);
  // main 仅在纯 theme 插件（无任何代码承载类型）时可省略——theme 是声明式皮肤，无入口。
  const themeOnly = types.every((t) => t === "theme");
  if (!themeOnly && typeof main !== "string") errors.push("main 不能为空");
  const uses = normalizeUses(data.uses, errors);
  const permissions = normalizePermissions(data.permissions, errors);
  const platforms = normalizeStringList(data.platforms, "platforms", errors);
  const theme = normalizeTheme(data.theme, errors);
  if (errors.length > 0) return { ok: false, errors };

  const manifest: PluginManifest = {
    schemaVersion: schemaVersion as number,
    id: id as string,
    name: name as string,
    version: version as string,
    type: type as PluginType,
    ...(typeof main === "string" && main.trim().length > 0 ? { main } : {}),
    scope: normalizeScope(data.scope),
    ...(types.length > 0 ? { types } : {}),
    ...(uses.length > 0 ? { uses } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
    ...(platforms.length > 0 ? { platforms } : {}),
    ...(theme ? { theme } : {}),
    ...(typeof data.atelyxVersionMin === "string" ? { atelyxVersionMin: data.atelyxVersionMin } : {}),
    ...(typeof data.atelyxVersionMax === "string" ? { atelyxVersionMax: data.atelyxVersionMax } : {}),
    ...(typeof data.tagline === "string" ? { tagline: data.tagline } : {}),
    ...(typeof mainUi === "string" && mainUi.trim().length > 0 ? { mainUi } : {}),
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    ...(typeof data.author === "string" ? { author: data.author } : {}),
    ...(typeof data.license === "string" ? { license: data.license } : {}),
    ...(Array.isArray(data.tags) && data.tags.every((t) => typeof t === "string")
      ? { tags: data.tags as string[] }
      : {}),
  };
  return { ok: true, manifest };
}

/** 全部分类归一化：附加分类只保留已知类型，未知的跳过（前向兼容）。 */
function normalizeTypes(type: string, rawTypes: unknown, errors: string[]): PluginType[] {
  if (rawTypes === undefined) return [type as PluginType];
  if (!Array.isArray(rawTypes)) {
    errors.push("types 必须是数组");
    return [];
  }
  const known: PluginType[] = [];
  for (const item of rawTypes) {
    if (typeof item === "string" && isKnownPluginType(item)) known.push(item as PluginType);
  }
  return [...new Set([type as PluginType, ...known])];
}

/** uses 归一化：只保留已知能力名，未知的跳过（前向兼容）。 */
function normalizeUses(rawUses: unknown, errors: string[]): PluginCapability[] {
  if (rawUses === undefined) return [];
  if (!Array.isArray(rawUses)) {
    errors.push("uses 必须是数组");
    return [];
  }
  const result: PluginCapability[] = [];
  for (const item of rawUses) {
    if (typeof item === "string" && isKnownCapability(item)) {
      const cap = item as PluginCapability;
      if (!result.includes(cap)) result.push(cap);
    }
  }
  return result;
}

/** permissions 归一化：必须是能力名 → 非空字符串的表。 */
function normalizePermissions(
  rawPermissions: unknown,
  errors: string[],
): Record<string, string> {
  if (rawPermissions === undefined) return {};
  if (typeof rawPermissions !== "object" || rawPermissions === null || Array.isArray(rawPermissions)) {
    errors.push("permissions 必须是对象");
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawPermissions as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) result[key] = value;
  }
  return result;
}

function normalizeStringList(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.length > 0)) {
    errors.push(`${field} 必须是非空字符串数组`);
    return [];
  }
  return raw as string[];
}

/** theme 归一化：variables 必填（字符串值表）、dark 可选；空主题视为未声明。 */
function normalizeTheme(raw: unknown, errors: string[]): PluginTheme | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("theme 必须是对象");
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const variables = normalizeVarTable(obj.variables);
  if (variables === undefined) {
    errors.push("theme.variables 必须是字符串值对象");
    return undefined;
  }
  let dark: Record<string, string> | undefined;
  if (obj.dark !== undefined) {
    dark = normalizeVarTable(obj.dark);
    if (dark === undefined) {
      errors.push("theme.dark 必须是字符串值对象");
      return undefined;
    }
  }
  if (Object.keys(variables).length === 0 && (!dark || Object.keys(dark).length === 0)) {
    return undefined; // 空主题（无任何覆盖）按未声明处理
  }
  return dark ? { variables, dark } : { variables };
}

function normalizeVarTable(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function normalizeScope(rawScope: unknown): PluginScope {
  return rawScope === "vault" ? "vault" : "app";
}

