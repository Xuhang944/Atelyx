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

/**
 * 单元格值：text/singleSelect = string；number/duration = number（秒）；image = 字符串数组（多图），
 * 条目 = 表格附件相对仓库根路径（`.atelyx/attachments/<tableId>/…`，图片外置）；
 * 遗留文件兼容 `data:` 内嵌 dataURL（加载迁移为附件路径，显示层两者均支持）。
 */
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

/**
 * 增量保存补丁（patch_table_vault，自动保存主路径 + 协作实时广播共用）：只含变化/新增/删除
 * 的字段与行。前端按「上次保存快照引用 diff」计算（store 不可变更新，未变实体引用相同）；
 * Rust 按稳定 id 合并到磁盘全量文件——image 字段只传路径引用（图片字节落隐藏附件目录，
 * 不随补丁/IPC 传输）。
 * 顺序变化（行拖拽排序/复制行/左右插列）经 `fieldOrder`/`rowOrder` 携带（当前实体 id 全序）——
 * 引用 diff 看不见数组顺序，必须显式传递，否则排序不落盘、协作者不可见。
 */
export interface TablePatch {
  /** 表格 id（防串文件守卫）。 */
  id: string;
  /** 标题变化时更新（title 变更 = 同目录改文件名 + 同步画布 table 节点引用）。 */
  title?: string;
  upsertFields: TableField[];
  removedFieldIds: string[];
  upsertRows: TableRow[];
  removedRowIds: string[];
  /** 字段 id 全序（与 lastSaved 序列不同时携带；Rust 按此重排，未出现 id 保持相对顺序置尾）。 */
  fieldOrder?: string[];
  /** 行 id 全序（同上）。 */
  rowOrder?: string[];
}
