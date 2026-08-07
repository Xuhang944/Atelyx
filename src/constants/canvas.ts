/**
 * 画布相关常量。
 */

/** 新建对话节点的默认尺寸（px）。较大便于直接输入多轮对话；用户可手动 resize 覆盖。 */
export const DEFAULT_CONVERSATION_WIDTH = 480;
export const DEFAULT_CONVERSATION_HEIGHT = 420;
/** 文本节点默认宽度（拖拽建节点/提取时初始宽度，创建时显式写入节点数据）。 */
export const DEFAULT_TEXT_NODE_WIDTH = 450;
/** 文本节点默认高度（拖拽建节点/提取时初始高度；resize 后随 .atlx 持久化覆盖）。 */
export const DEFAULT_TEXT_NODE_HEIGHT = 420;

/** 分组节点默认尺寸（空白右键「添加分组」创建时写入节点数据）。 */
export const DEFAULT_GROUP_WIDTH = 480;
export const DEFAULT_GROUP_HEIGHT = 320;

/** 链接节点默认尺寸（空白右键「添加链接」创建时写入节点数据）。 */
export const DEFAULT_LINK_WIDTH = 240;
export const DEFAULT_LINK_HEIGHT = 96;

/**
 * 分组节点色板（对齐外部白板格式的颜色下标 "1"-"5"）。
 * 分组节点 header 色块按钮弹出选择（1-5 或默认）；缺省 = 默认中性灰（与 "6" 同色故不提供）。
 */
export const GROUP_COLORS: Record<string, string> = {
  "1": "#e05252",
  "2": "#e07b39",
  "3": "#4fae6a",
  "4": "#4f8fd0",
  "5": "#9b6fd0",
};

/** `.atlx` 文件 schema 版本号（Rust 侧 `vault.rs` 有同名常量，两端须保持一致）。 */
export const CANVAS_SCHEMA = "atelyx-canvas/v1" as const;
