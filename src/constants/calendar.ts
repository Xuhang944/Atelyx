/**
 * 日历（主页面板）常量：日程存储文件/schema + 自动进日历的笔记 frontmatter 字段。
 */

/** `.atelyx/calendar.json` 文件 schema 版本（前端自持，无 Rust 强校验）。 */
export const CALENDAR_SCHEMA = "atelyx-calendar/v1" as const;

/** 手动日程存储文件（仓库级，随仓库同步）。 */
export const CALENDAR_FILE = ".atelyx/calendar.json";

/** 手动日程展示色板（缺省条目色，随机取用）。 */
export const CALENDAR_ITEM_COLORS = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#d19a66",
];
