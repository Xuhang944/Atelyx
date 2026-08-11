/**
 * 强调色工具：自定义强调色（仓库级）由 App 层动态覆盖 CSS 变量时，
 * `--accent-hover`（暗化）与 `--accent-fg`（对比前景）无法直接由用户输入推导，
 * 统一在此计算（输入 hex，输出 hex；非法输入回退默认金色）。
 */

/** 金色默认强调色（与 styles/index.css 的 --accent 同源）。 */
export const DEFAULT_ACCENT = "#d4af37";
/** hover 暗化系数（与默认金 #d4af37 → hover #b8962e 的 0.86 倍一致）。 */
const DARKEN_FACTOR = 0.86;

/** 前景阈值：相对亮度高于此值时底上用深色文字（默认金用深字），否则白字。 */
const FOREGROUND_LUMINANCE_THRESHOLD = 0.4;

/** 解析 `#rrggbb` 为 [r, g, b]（0-255）；非法输入返回金色。 */
function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [212, 175, 55];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** 暗化强调色（hover 态用，系数 0.86 对齐默认金 hover）。 */
export function darkenHex(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * DARKEN_FACTOR, g * DARKEN_FACTOR, b * DARKEN_FACTOR);
}

/**
 * 强调色底上的前景文字色：按 WCAG 相对亮度判定——亮度高（如金色）用深色文字保证对比度，
 * 亮度低用白字。
 */
export function foregroundFor(hex: string): string {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const linear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > FOREGROUND_LUMINANCE_THRESHOLD ? "#1c1c1e" : "#ffffff";
}
