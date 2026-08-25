/**
 * 主页面板数据 service（日历/仓库历史）：带日期笔记扫描 + 全仓库历史版本聚合。
 * 对应 Rust `commands/home.rs`，只读、尽力而为（缺失/损坏文件已由 Rust 侧跳过）。
 * 响应类型定义在 `types/home.ts`（组件可用的类型来源，本文件按服务层职责 re-export）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { DatedNote, RepoHistoryResult } from "@/types";

export type { DatedNote, RepoHistoryEntry, DailyCount, RepoHistoryResult } from "@/types";

/** 扫描仓库 `.md` frontmatter 的 date/due 字段（自动进日历）。 */
export async function listDatedNotes(): Promise<DatedNote[]> {
  return invoke<DatedNote[]>("list_dated_notes");
}

/** 聚合 `.atelyx/history/` 全部版本（版本流 + 按日计数）。 */
export async function listRepoHistory(): Promise<RepoHistoryResult> {
  return invoke<RepoHistoryResult>("list_repo_history");
}
