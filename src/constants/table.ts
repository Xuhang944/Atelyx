/**
 * 多维表格（.atb）相关常量。
 */
import type { CalcType, FieldType } from "@/types/table";

/** `.atb` 文件 schema 版本号（Rust 侧 `vault.rs` 有同名常量，两端须保持一致）。 */
export const TABLE_SCHEMA = "atelyx-table/v1" as const;

/** 表格文件扩展名（Atelyx Table，小写）。 */
export const TABLE_EXT = "atb";

/** 字段类型显示名（字段管理菜单 / 类型切换用）。 */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "文本",
  number: "数字",
  duration: "时长（秒）",
  singleSelect: "单选",
  image: "图片",
};

/** 状态栏自动计算类型显示名。 */
export const CALC_TYPE_LABELS: Record<CalcType, string> = {
  sum: "求和",
  avg: "平均",
  max: "最大",
  min: "最小",
  count: "计数",
};

/** 各字段类型可用的自动计算（数字类统计，其余计数非空值）。 */
export const CALC_TYPES_BY_FIELD: Record<FieldType, CalcType[]> = {
  number: ["sum", "avg", "max", "min", "count"],
  duration: ["sum", "avg", "max", "min", "count"],
  text: ["count"],
  singleSelect: ["count"],
  image: ["count"],
};

/** 时间线卡片宽度：每秒时长对应的 px。 */
export const TIMELINE_PX_PER_SEC = 60;
/** 时间线卡片最短宽度（时长过短/缺失时兜底，px）。 */
export const TIMELINE_MIN_CARD_WIDTH = 120;
/** 时间线无 duration 字段时的等宽卡片宽度（px）。 */
export const TIMELINE_EQUAL_CARD_WIDTH = 160;
/** 时间线卡片间距（px）。 */
export const TIMELINE_CARD_GAP = 6;
/** 预演默认每行播放时长（秒；无 duration 字段或值为空时）。 */
export const PREVIEW_DEFAULT_DURATION = 3;
/** 注入对话上下文的表格行数上限（防超长上下文）。 */
export const MAX_TABLE_INJECT_ROWS = 50;
/** 列宽拖拽调整的下限（px）。 */
export const MIN_COL_WIDTH = 120;
/** 列宽拖拽调整的上限（px）。 */
export const MAX_COL_WIDTH = 360;
/** 行高拖拽调整的下限（px；行首操作区高 32px）。 */
export const MIN_ROW_HEIGHT = 32;
/** 行高拖拽调整的上限（px）。 */
export const MAX_ROW_HEIGHT = 600;
/** 行号列固定宽度（px）。 */
export const ROW_NUM_COL_WIDTH = 40;
/** 表头末尾「+」添加字段列固定宽度（px）。 */
export const ADD_FIELD_COL_WIDTH = 48;
