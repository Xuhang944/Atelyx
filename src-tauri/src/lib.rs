//! Atelyx Tauri 后端入口。
//! 负责命令注册与仓库/watcher 状态托管。
//!
//! 文件化仓库（`vault.rs`）为唯一存储出口。

mod commands;
mod vault;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 自动检查更新（tauri-plugin-updater，endpoints/pubkey 见 tauri.conf.json）
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            // 仓库化：注册当前仓库根路径状态（初始为 None，open_vault 时设置）
            app.manage(vault::VaultState::default());
            // 文件监听：持有当前仓库的 notify debouncer，open_vault 时启动
            app.manage(watcher::WatcherState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 仓库文件化命令
            commands::vault::open_vault,
            commands::vault::list_canvases_vault,
            commands::vault::read_canvas_vault,
            commands::vault::write_canvas_vault,
            commands::vault::rename_canvas_vault,
            commands::vault::move_canvas_vault,
            commands::vault::delete_canvas_vault,
            commands::vault::read_note,
            commands::vault::write_note,
            commands::vault::read_whiteboard_canvas,
            commands::vault::rename_note,
            commands::vault::read_vault_config,
            commands::vault::write_vault_config,
            commands::vault::read_prompt_notes,
            commands::vault::write_prompt_notes,
            commands::vault::read_editor_chats,
            commands::vault::write_editor_chats,
            commands::vault::read_chat_messages,
            commands::vault::write_chat_messages,
            commands::vault::delete_chat_messages,
            // 仓库级 UI 使用状态（.atelyx/ui-state.json：文件面板展开 + 上次打开文件）
            commands::vault::read_ui_state,
            commands::vault::write_ui_state,
            commands::vault::ensure_default_vault,
            commands::vault::create_canvas_vault,
            // 仓库文件管理（全仓库文件树 + 建文件夹 + 删改 + 附件 dataURL + 链接维护）
            commands::vault::list_vault_tree,
            commands::vault::create_folder,
            commands::vault::delete_folder,
            commands::vault::rename_folder,
            commands::vault::delete_note,
            commands::vault::delete_attachment,
            commands::vault::rename_attachment,
            commands::vault::read_attachment_data_url,
            commands::vault::import_attachment_vault,
            // 全局配置（global.json，最近仓库列表等）
            commands::global::read_global_config,
            commands::global::write_global_config,
            // API key 安全存储（OS keychain，见 commands/keychain.rs）
            commands::keychain::set_api_key,
            commands::keychain::get_api_key,
            commands::keychain::delete_api_key,
            // 联网搜索代理（Tavily/SearXNG，Rust 侧请求绕 CORS + key 不进 WebView）
            commands::search::search_web,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
