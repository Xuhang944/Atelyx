//! API key 安全存储命令（按仓库隔离）。
//!
//! 通过 `keyring` crate 把 AI provider 的 API key 存入 OS keychain：
//! - Windows：Windows Credential Manager
//! - Linux：Secret Service（DBus，需 gnome-keyring / kwalletd）
//! - macOS：Keychain Services
//!
//! 安全边界：API key 默认仅存 keychain，不落仓库文件或 `global.json`；
//! 仅当仓库开启 `syncKeys`（「API key 随仓库保存」，多设备同步）时前端才把 key 明文写入
//! `config.json`（`vault.rs` 的 `VaultProvider.api_key` 为可选字段，默认不落盘 = 类型层守边界）。
//!
//! service = `com.atelyx.app`（对齐 tauri.conf.json identifier），
//! username = `provider-<vaultId>-<providerId>`（**按仓库隔离**：各仓库独立 key，
//! 与仓库级配置 `VaultConfig.providers` 配套；Tavily key 的 providerId 传 `search-tavily`）。

use keyring::Entry;

/// keychain 的 service 名（对齐 `tauri.conf.json` 的 `identifier`）。
const SERVICE: &str = "com.atelyx.app";

/// 按仓库 + provider id 构造 keychain username（key 按仓库隔离，防跨仓库搞混）。
fn username_for(vault_id: &str, provider_id: &str) -> String {
    format!("provider-{}-{}", vault_id, provider_id)
}

/// 保存 API key 到 keychain（按仓库 + provider id）。
/// 空串会覆盖旧值（前端删除 key 时传空串即可，无需调 delete）。
#[tauri::command]
pub fn set_api_key(vault_id: String, provider_id: String, key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &username_for(&vault_id, &provider_id)).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

/// 读取仓库内 provider 的 API key。
/// 条目不存在（NoEntry）返回空串，与「未设置 key」语义一致；keychain 故障返回 Err。
#[tauri::command]
pub fn get_api_key(vault_id: String, provider_id: String) -> Result<String, String> {
    let entry = Entry::new(SERVICE, &username_for(&vault_id, &provider_id)).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 删除仓库内 provider 的 keychain 条目（幂等：条目不存在视为成功）。
#[tauri::command]
pub fn delete_api_key(vault_id: String, provider_id: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &username_for(&vault_id, &provider_id)).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
