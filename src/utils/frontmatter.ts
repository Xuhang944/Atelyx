/**
 * Frontmatter 解析/序列化工具（笔记属性面板数据层）。
 *
 * 解析用 `gray-matter`（内部 js-yaml v3）：
 * - 兼容 `tags: [a, b]` 与 `tags:\n  - a` 两种数组写法（解析结果均为 string[]）；
 * - `stringify` 的 options 会透传给 js-yaml dump——必须显式传 `lineWidth` 防默认 80 列折行长值，
 *   `noRefs` 防序列化时出现 `&ref` 引用标记；
 * - 空对象序列化时不输出 `---` 块（删光属性后文件自然回到无 frontmatter 态）。
 */
import matter from "gray-matter";

// gray-matter 依赖 Node 全局 Buffer（lib/utils.js 的 toBuffer 调 Buffer.from，每次解析都执行），
// WebView2 浏览器无此全局 → 提供最小 shim：本项目输入恒为字符串，原样返回即可（kind-of 判断 buffer 类型不依赖全局）。
if (typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer?: unknown }).Buffer = {
    from: (input: string) => input,
  };
}

/** 可被属性面板内联编辑的 Frontmatter 值类型（未知类型只读展示，不进编辑契约）。 */
export type EditableFrontmatterValue = string | string[];

/** 笔记属性契约：约定键 + 动态键值对（属性面板）。 */
export interface Frontmatter {
  tags?: string[];
  timeline?: string[];
  status?: string;
  [key: string]: string | string[] | undefined;
}

/** 解析结果：data 用宽类型保留未知类型值（数字/布尔/嵌套等，只读展示不破坏类型）。 */
export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** frontmatter 之后的正文（不含 `---` 块，编辑时原样拼回）。 */
  body: string;
  /** 文件开头 frontmatter 块原文（含闭合换行，格式原样保留）；无 frontmatter 时为空串。
   * 正文编辑合并回完整 content 时用 `fmPrefix + body`，避免 stringify 重排 frontmatter 格式。 */
  fmPrefix: string;
  /** YAML 格式错误时 false（面板显示小红条，不阻塞正文编辑）。 */
  ok: boolean;
}

/** 徽章类 key（内置标签属性）：渲染为 `#` 前缀徽章；其余数组渲染为 Clock 列表。 */
const BADGE_KEYS = new Set(["tags", "aliases", "cssclasses"]);

export function isBadgeKey(key: string): boolean {
  return BADGE_KEYS.has(key);
}

/** gray-matter 的类型声明未覆盖 js-yaml dump 的透传参数，此处补充（官方文档说明 options 会传给 js-yaml）。 */
interface StringifyOptions extends matter.GrayMatterOption<string, never> {
  lineWidth?: number;
  noRefs?: boolean;
}

const YAML_OPTIONS: StringifyOptions = { lineWidth: 1000, noRefs: true };

export function parseFrontmatter(content: string): ParsedFrontmatter {
  let data: Record<string, unknown> = {};
  let body = content;
  let fmPrefix = "";
  let ok = true;
  try {
    const file = matter(content);
    data = file.data as Record<string, unknown>;
    // gray-matter 会剥掉 frontmatter 闭合后紧跟的一个换行（body 前导空行丢失，源码 index.js 行为），
    // 自己按文件开头 `---` 块定位：fmPrefix 保留块原文（格式/CRLF 原样），body 字节级保留正文，
    // 保证「仅编辑正文/属性不改变另一侧内容」；内容组可选以支持空 frontmatter（`---\n---`，模板插入形态）
    const fm = content.match(/^---[^\n]*\r?\n([\s\S]*?\r?\n)?---[^\n]*(?:\r?\n)?/);
    if (fm) {
      fmPrefix = fm[0];
      body = content.slice(fm[0].length);
    }
  } catch (e) {
    ok = false;
    // 诊断日志：仅记录错误信息（不含笔记内容，防隐私落日志）；格式错误已有 UI 红条提示
    console.error("[frontmatter] parse error:", (e as Error).message);
  }
  return { data, body, fmPrefix, ok };
}

export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  let out = matter.stringify({ content: body }, data, YAML_OPTIONS);
  // gray-matter 在 body 结尾无换行时会补一个（lib/stringify.js newline()），
  // 还原为原 body 形态：仅编辑属性不应改变正文内容
  if (!body.endsWith("\n")) out = out.replace(/\n$/, "");
  // 外部工具产生的 CRLF 文件（Windows）：frontmatter 块跟随正文换行风格，避免文件内混用
  if (body.includes("\r\n")) {
    const fm = out.match(/^---[^\n]*\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/);
    if (fm) out = fm[0].replace(/(?<!\r)\n/g, "\r\n") + out.slice(fm[0].length);
  }
  return out;
}
