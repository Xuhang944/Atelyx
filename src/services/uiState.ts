/**
 * 应用级 UI 使用状态 service。
 *
 * 读写 `app_data_dir/ui-state.json`，对应 Rust `commands/global.rs` 的
 * `read_app_ui_state`/`write_app_ui_state`。承载：工作区布局（布局列表 +
 * 激活布局 + 聚焦面板）+ 上次打开文件 + 文件面板展开——应用级、跨仓库共享，
 * 本机独有不随仓库同步（无需按设备分桶）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppUiState } from "@/types";

/** 读应用级 UI 状态（文件不存在/损坏返回默认：展开空、默认布局、无上次打开文件）。 */
export async function readAppUiState(): Promise<AppUiState> {
  return invoke<AppUiState>("read_app_ui_state");
}

/** 写应用级 UI 状态（原子写）。 */
export async function writeAppUiState(state: AppUiState): Promise<void> {
  await invoke("write_app_ui_state", { state });
}
