//! Tauri 命令模块。
//! 每个命令对应前端 invoke 调用，统一在 lib.rs 的 generate_handler! 中注册。

pub mod global;
pub mod keychain;
pub mod search;
pub mod vault;
