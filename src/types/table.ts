/**
 * `.atb` 表格文件 schema 类型（磁盘格式，atelyx-table/v1）。
 *
 * 泛用多维表格：字段完全用户自定义，无内置模板。
 * 分镜板等用法 = 用户自建字段（镜号/景别/时长/分镜图…）+ 时间线/预演视图。
 */
import type { TABLE_SCHEMA } from "@/constants/table";

/** 字段类型（file 类型二期预留——渲染遇未知类型一律降级为只读文本，前向兼容）。 */
export type FieldType = "text" | "number" | "duration" | "singleSelect" | "image";

/** 状态栏列自动计算类型。 */
export type CalcType = "sum" | "avg" | "max" | "min" | "count";

/** 单元格值：text/singleSelect = string；number/duration = number（秒）；image = dataURL 数组（多图）。 */
export type CellValue = string | number | string[];

export interface TableField {
  id: string;
  name: string;
  type: FieldType;
  /** singleSelect 的选项列表（其他类型不使用）。 */
  options?: string[];
  /** 用户拖拽调整后的列宽（px）；缺省 = 按字段名称字数自适应。 */
  width?: number;
  /** 状态栏自动计算类型（缺省 = 无计算；随 .atb 持久化）。 */
  calcType?: CalcType;
}

export interface TableRow {
  id: string;
  /** 按字段 id 存值（缺 key = 空单元格；undefined 序列化时丢弃，保持文件干净）。 */
  values: Record<string, CellValue | undefined>;
  /** 用户拖拽调整后的行高（px）；缺省 = 内容自然撑开（行高自适应清除）。 */
  height?: number;
}

/** `.atb` 文件根结构。 */
export interface TableFile {
  schema: typeof TABLE_SCHEMA;
  id: string;
  title: string;
  fields: TableField[];
  rows: TableRow[];
  createdAt: number;
  updatedAt: number;
}

/** `create_table_vault` 返回值：id（运行时身份）+ file（磁盘定位）。 */
export interface TableCreateResult {
  id: string;
  file: string;
}
