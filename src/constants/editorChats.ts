/**
 * AI 对话面板相关常量。
 */

/** `.atelyx/editor-chats.json` 的 schema 版本号（Rust 侧 `vault.rs` 有同名常量，两端须保持一致）。 */
export const EDITOR_CHATS_SCHEMA = "atelyx-editor-chats/v2" as const;

/** v1 schema（存量兼容：load 检测到 v1 时把内嵌消息导出为消息 .md，写盘落 v2 索引）。 */
export const EDITOR_CHATS_SCHEMA_V1 = "atelyx-editor-chats/v1" as const;

/** 会话消息正文 .md 目录（相对仓库根；位于 `.atelyx/` 下——watcher 不监听、文件面板不显示，无自写回环）。 */
export const CHAT_HISTORY_DIR = ".atelyx/对话历史";

/** 会话消息正文文件扩展名。 */
export const CHAT_MESSAGE_EXT = ".md";
