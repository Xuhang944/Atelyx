//! 全局配置命令（应用级数据）。
//!
//! 读写 `app_data_dir/global.json`：**最近打开仓库列表 + 自动更新开关**（应用级配置）。
//! AI 供应商 / 搜索源已仓库化（`vault.rs` 的 `VaultConfig.providers/search`），
//! 不再由本文件承载；API key 永不落文件（仅存 keychain，见 `commands/keychain.rs`）——
//! 旧 `ai`/`search`/`device_id` 字段读回时被 serde 忽略（未知字段），不再写回。
//!
//! 另有 `app_data_dir/ui-state.json`（应用级 UI 使用状态：工作区布局 + 上次打开文件 +
//! 文件面板展开，见下方 `AppUiState`）。app_data_dir 本机独有、不随仓库同步，
//! 无需按设备分桶——各仓库 `.atelyx/ui-state.json` 的分桶模型已废弃。
//!
//! 整文件读写 + 原子写（写 `.tmp` → rename）。前端用 `updateGlobalConfig`（read-modify-write）
//! 而非直接 `write_global_config`，避免覆盖其他字段。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 最近打开的仓库条目。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub root: String,
    pub name: String,
    pub last_opened_at: i64,
}

/// 全局配置根结构（**最近仓库列表 + 自动更新开关**；旧 ai/search/deviceId 字段读回时被忽略）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfig {
    #[serde(default)]
    pub recent_vaults: Vec<RecentVault>,
    /// 自动检查更新（应用级）：开启后每次启动应用静默检查新版本并自动安装。缺省 None = 关闭。
    #[serde(default)]
    pub auto_update: Option<bool>,
}

fn global_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("global.json"))
}

/// 归一化仓库根路径：dunce::canonicalize 去除 Windows `\\?\` 长路径前缀 + 解析 `..`/符号链接，
/// 保证同一物理目录只存一种格式（如 `E:\测试仓库`）。路径已不存在时保留原字符串
/// （列表里要能显示/移除已删仓库，不因归一化失败丢条目）。
fn normalize_vault_root(root: &str) -> String {
    let p = Path::new(root);
    if p.is_absolute() {
        dunce::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.to_string())
    } else {
        root.to_string()
    }
}

/// 最近仓库列表归一化 + 去重（按归一化后路径精确去重，保留首次出现顺序）。
/// 兼容历史脏数据：同一物理目录可能同时存有 `\\?\E:\x` 与 `E:\x` 两条；
/// name 为空（网络共享根等历史 `file_name()` 取不到的条目）按路径重新推导。
fn normalize_and_dedupe_vaults(mut recents: Vec<RecentVault>) -> Vec<RecentVault> {
    let mut seen = std::collections::HashSet::new();
    recents.retain(|v| {
        let norm = normalize_vault_root(&v.root);
        seen.insert(norm)
    });
    for v in &mut recents {
        if v.name.trim().is_empty() {
            v.name = crate::vault::vault_display_name(Path::new(&v.root));
        }
    }
    recents
}

/// 读全局配置（文件不存在或解析失败时返回空配置，不报错——允许首次启动/手编辑损坏）。
/// 返回前对 recentVaults 归一化去重，兼容旧版本写入的 `\\?\` 前缀脏数据。
#[tauri::command]
pub fn read_global_config(app: AppHandle) -> Result<GlobalConfig, String> {
    let path = global_config_path(&app)?;
    if !path.exists() {
        return Ok(GlobalConfig::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut config = match serde_json::from_str::<GlobalConfig>(&data) {
        Ok(c) => c,
        Err(_) => GlobalConfig::default(),
    };
    config.recent_vaults = normalize_and_dedupe_vaults(config.recent_vaults);
    Ok(config)
}

/// 写全局配置（原子写：`.tmp` → rename）。
/// 写入前对 recentVaults 归一化去重，保证落盘路径格式统一（验收标准：无 `\\?\` 前缀）。
#[tauri::command]
pub fn write_global_config(app: AppHandle, mut config: GlobalConfig) -> Result<(), String> {
    config.recent_vaults = normalize_and_dedupe_vaults(config.recent_vaults);
    let path = global_config_path(&app)?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== 应用级 UI 使用状态（app_data_dir/ui-state.json）=====
// 工作区布局（布局列表 + 激活布局 + 聚焦面积）+ 上次打开文件 + 文件面板展开，
// 全部应用级：app_data_dir 本机独有、不随仓库同步，跨仓库共享（无需按设备分桶）。
// 与全局配置（global.json）分离：高频展开/折叠/拖拽写入抖动不进配置。

/// ui-state.json 的 schema 版本（与前端 types/uiState.ts 的 UI_STATE_SCHEMA 对齐）。
pub const UI_STATE_SCHEMA: &str = "atelyx-ui-state/v1";

/// 应用级 UI 使用状态（扁平结构；`workspace_layouts` 区域树由前端自持 schema）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUiState {
    pub schema: String,
    /// 文件面板展开的文件夹相对路径列表（缺省 = 全部折叠；跨仓库按路径共享）。
    #[serde(default)]
    pub file_explorer_expanded: Vec<String>,
    /// 上次打开的画布文件（相对仓库根路径；恢复时按当前仓库列表查找命中才打开）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_canvas_file: Option<String>,
    /// 上次打开的笔记文件（相对仓库根路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_file: Option<String>,
    /// 上次打开的表格文件（相对仓库根路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_table_file: Option<String>,
    /// 工作区布局列表（区域树结构；缺省 = 默认布局）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_layouts: Option<serde_json::Value>,
    /// 激活布局 id（缺省 = 布局列表第一个）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_layout_id: Option<String>,
    /// 聚焦面积 id（画布快捷键门控；缺省 = 布局第一个面积）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_area_id: Option<String>,
}

fn app_ui_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ui-state.json"))
}

/// 读应用级 UI 状态（不存在返回默认；解析失败/损坏降级为默认——手编辑损坏只影响恢复，不阻塞）。
#[tauri::command]
pub fn read_app_ui_state(app: AppHandle) -> Result<AppUiState, String> {
    let path = app_ui_state_path(&app)?;
    if !path.exists() {
        return Ok(AppUiState::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let state = serde_json::from_str::<AppUiState>(&json).unwrap_or_default();
    // schema 校验：不符即拒绝（同 .atlx/editor-chats 私有格式保护，防外部工具/手改误写）
    if state.schema != UI_STATE_SCHEMA {
        return Ok(AppUiState::default());
    }
    Ok(state)
}

/// 写应用级 UI 状态（原子写：`.tmp` → rename）。
#[tauri::command]
pub fn write_app_ui_state(app: AppHandle, state: AppUiState) -> Result<(), String> {
    let path = app_ui_state_path(&app)?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
