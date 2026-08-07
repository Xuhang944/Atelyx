/**
 * 仓库级 UI 使用状态（`.atelyx/ui-state.json`，schema `atelyx-ui-state/v1`）。
 *
 * 与仓库级配置（`.atelyx/config.json`）分离：config.json 只保存「用户设置」
 * （主题/AI 供应商/排序等），本文件保存「使用数据」（文件面板展开情况、
 * 上次打开的文件）——高频展开/折叠的写入抖动不进配置，损坏也只影响恢复。
 *
 * **按设备分桶**：仓库可能随 Git/云盘多设备同步，状态存 `perDevice`（key = 本设备 ID，
 * 见 `GlobalConfig.deviceId`），各设备读写自己的桶，互不覆盖。旧平铺字段
 * （`fileExplorerExpanded`/`lastCanvasFile`/`lastNoteFile`/`lastActiveWindow`）
 * 仅兼容读取迁移——本设备首次写入后不再落盘。
 *
 * 该文件位于 `.atelyx` 隐藏目录内，watcher 天然过滤、无自写回环
 * （与 `prompt-notes.json` / `editor-chats.json` 同策略）。
 */

/** `ui-state.json` 文件 schema 版本（Rust 侧 `vault.rs` 有同名常量，两端须保持一致）。 */
export const UI_STATE_SCHEMA = "atelyx-ui-state/v1" as const;

/** 上次退出时的窗口布局（双窗口并存：画布 + 笔记各一个）。 */
export type LastActiveWindow = "canvas" | "note";

/** 单设备的仓库级 UI 使用状态（`VaultUiState.perDevice` 的一个条目）。 */
export interface DeviceUiState {
  /** 文件面板展开的文件夹相对路径列表（缺省 = 全部折叠）。 */
  fileExplorerExpanded: string[];
  /** 上次打开的画布文件（相对仓库根路径；关闭/删除后清空）。 */
  lastCanvasFile?: string;
  /** 上次打开的笔记文件（相对仓库根路径；关闭/删除后清空）。 */
  lastNoteFile?: string;
  /** 上次激活的窗口（画布 / 笔记；缺省 = 画布槽）。 */
  lastActiveWindow?: LastActiveWindow;
}

/** 仓库级 UI 使用状态（`.atelyx/ui-state.json` 磁盘格式）。 */
export interface VaultUiState {
  schema: typeof UI_STATE_SCHEMA;
  /** 各设备的 UI 状态（key = 设备 ID；缺省 = 该设备无条目，回退旧平铺字段）。 */
  perDevice?: Record<string, DeviceUiState>;
  // 旧平铺字段：仅兼容读取迁移（本设备首次写入后不再落盘），新写入只写 perDevice。
  /** 文件面板展开的文件夹相对路径列表（旧格式，见 perDevice）。 */
  fileExplorerExpanded?: string[];
  /** 上次打开的画布文件（旧格式，见 perDevice）。 */
  lastCanvasFile?: string;
  /** 上次打开的笔记文件（旧格式，见 perDevice）。 */
  lastNoteFile?: string;
  /** 上次激活的窗口（旧格式，见 perDevice）。 */
  lastActiveWindow?: LastActiveWindow;
}
