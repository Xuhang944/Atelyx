/**
 * 应用级 UI 使用状态（`app_data_dir/ui-state.json`，schema `atelyx-ui-state/v1`）。
 *
 * 工作区布局（布局列表 + 激活布局 + 聚焦面积）+ 上次打开的文件 + 文件面板展开，
 * 全部**应用级**：app_data_dir 本机独有、不随仓库同步，跨仓库共享——
 * 布局/展开/上次文件是个人使用偏好，与仓库无关（各仓库 `.atelyx/ui-state.json`
 * 的按设备分桶模型已废弃）。
 *
 * 与全局配置（global.json）分离：global.json 只保存低频配置（最近仓库列表 +
 * 自动更新开关），本文件保存高频「使用数据」——写入抖动不进配置，损坏只影响恢复。
 */
import type { DetachedWindow, WorkspaceLayout } from "@/types/workspaceLayout";

/** `ui-state.json` 文件 schema 版本（Rust 侧 `commands/global.rs` 有同名常量，两端须保持一致）。 */
export const UI_STATE_SCHEMA = "atelyx-ui-state/v1" as const;

/** 应用级 UI 使用状态（`app_data_dir/ui-state.json` 磁盘格式，扁平无分桶）。 */
export interface AppUiState {
  schema: typeof UI_STATE_SCHEMA;
  /** 文件面板展开的文件夹相对路径列表（缺省 = 全部折叠；跨仓库按路径共享）。 */
  fileExplorerExpanded: string[];
  /** 上次打开的画布文件（相对仓库根路径；恢复时按当前仓库列表查找命中才打开）。 */
  lastCanvasFile?: string;
  /** 上次打开的笔记文件（相对仓库根路径）。 */
  lastNoteFile?: string;
  /** 上次打开的表格文件（相对仓库根路径）。 */
  lastTableFile?: string;
  /** 工作区布局列表（缺省 = 无条目时回退默认布局）。 */
  workspaceLayouts?: WorkspaceLayout[];
  /** 激活布局 id（缺省 = 布局列表第一个）。 */
  activeLayoutId?: string;
  /** 聚焦面积 id（画布快捷键门控；缺省 = 布局第一个面积）。 */
  focusedAreaId?: string;
  /** 撕裂出去的独立窗口（应用级、跨布局共享；缺省 = 无）。 */
  detachedWindows?: DetachedWindow[];
}
