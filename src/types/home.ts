/**
 * 主页数据响应类型（`services/home.ts` 的返回契约，Rust `commands/home.rs` camelCase 对齐）。
 * 独立成类型层：组件不得 import 自 services/，此处作为组件可用的类型来源。
 */

/** 带日期笔记（frontmatter `date`/`due` 自动进日历；值为 `YYYY-MM-DD`）。 */
export interface DatedNote {
  file: string;
  title: string;
  date?: string | null;
  due?: string | null;
}

/** 历史版本元数据（聚合展示；不含全文 content）。 */
export interface RepoHistoryEntry {
  file: string;
  kind: "note" | "canvas" | "table";
  ts: number;
  authorId: string;
  authorName: string;
  authorDevice: string;
  action: string;
  summary?: string | null;
  note?: string | null;
}

/** 按日历史版本计数（活动日历数据源）。 */
export interface DailyCount {
  date: string;
  count: number;
}

/** list_repo_history 返回：版本流（ts 倒序、上限）+ 全量按日计数。 */
export interface RepoHistoryResult {
  entries: RepoHistoryEntry[];
  dailyCounts: DailyCount[];
}
