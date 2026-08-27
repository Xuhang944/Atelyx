import type { FileExplorerSortKey, FileTreeNode } from "@/types";

/** 排序方式（目录/文件均含 mtime，故只提供文件名/编辑时间两类；作用于树每层）。 */
export const SORT_OPTIONS: { key: FileExplorerSortKey; label: string }[] = [
  { key: "name-asc", label: "文件名 (A-Z)" },
  { key: "name-desc", label: "文件名 (Z-A)" },
  { key: "mtime-desc", label: "编辑时间 (从新到旧)" },
  { key: "mtime-asc", label: "编辑时间 (从旧到新)" },
];

/** 默认排序（与仓库级配置缺省一致）。 */
export const DEFAULT_SORT_KEY: FileExplorerSortKey = "mtime-desc";

/** 文件夹图标颜色预设色板（右键「图标颜色」选择；独立落盘 .atelyx/folder-colors.json）。 */
export const FOLDER_COLOR_PRESETS = [
  "#e05252",
  "#e07b39",
  "#e0b436",
  "#4fae6a",
  "#2f9e8f",
  "#4f8fd0",
  "#7a6fd0",
  "#c05fa8",
];

/** 仓库级配置可能被外部手改，非法值回退默认。 */
export function isSortKey(v: FileExplorerSortKey | undefined): v is FileExplorerSortKey {
  return SORT_OPTIONS.some((o) => o.key === v);
}

/** 大写文件扩展名（不含英文句号），无扩展名返回空串。 */
export function upperExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toUpperCase() : "";
}

/** 名称切成「数字段 / 非数字段」交替序列（中文字符属非数字段）。 */
const NATURAL_BLOCKS = /\d+|\D+/g;

/** 数字段按数值比较（1000 进制：file2 < file10）；前导零多者排后（1 < 01）。 */
function compareNumeric(a: string, b: string): number {
  const ta = a.replace(/^0+/, "");
  const tb = b.replace(/^0+/, "");
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  if (ta === tb) return a.length - b.length;
  return ta < tb ? -1 : 1;
}

/** 自然排序：数字段按数值（1000 进制）、非数字段按中文本地化比较。 */
function compareNatural(a: string, b: string): number {
  const pa = a.match(NATURAL_BLOCKS) ?? [];
  const pb = b.match(NATURAL_BLOCKS) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const sa = pa[i];
    const sb = pb[i];
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const c = compareNumeric(sa, sb);
      if (c !== 0) return c;
    } else if (na !== nb) {
      return na ? -1 : 1; // 数字段排前（"章2" < "章A"）
    } else {
      const c = sa.localeCompare(sb, "zh");
      if (c !== 0) return c;
    }
  }
  return pa.length - pb.length;
}

/** 递归收集树中全部文件夹路径（「展开/收起全部」用）。 */
export function collectDirPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.isDir) {
      out.push(n.path);
      out.push(...collectDirPaths(n.children));
    }
  }
  return out;
}

/** 每层排序：文件夹固定按名称 A-Z（自然排序），文件按 sortKey（名称排序也用自然排序）。 */
export function sortChildren(children: FileTreeNode[], sortKey: FileExplorerSortKey): FileTreeNode[] {
  const dirs = children.filter((c) => c.isDir);
  const files = children.filter((c) => !c.isDir);
  const byName = (asc: boolean) => (a: FileTreeNode, b: FileTreeNode) =>
    asc ? compareNatural(a.name, b.name) : compareNatural(b.name, a.name);
  const byMtime = (asc: boolean) => (a: FileTreeNode, b: FileTreeNode) =>
    asc ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
  const dirCmp = (a: FileTreeNode, b: FileTreeNode) => compareNatural(a.name, b.name);
  const fileCmp = sortKey.startsWith("name") ? byName(sortKey.endsWith("asc")) : byMtime(sortKey.endsWith("asc"));
  return [...dirs.sort(dirCmp), ...files.sort(fileCmp)];
}
