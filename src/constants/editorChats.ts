/**
 * AI 对话面板相关常量。
 */

/** `.atelyx/editor-chats.json` 的 schema 版本号（Rust 侧 `vault.rs` 有同名常量，两端须保持一致）。 */
export const EDITOR_CHATS_SCHEMA = "atelyx-editor-chats/v3" as const;

/** 会话消息正文 .jsonl 目录（相对仓库根；位于 `.atelyx/` 下——watcher 不监听、文件面板不显示，无自写回环）。 */
export const CHAT_HISTORY_DIR = ".atelyx/对话历史";

/** 会话消息正文文件扩展名（JSON Lines：一行一条消息记录，追加式写）。 */
export const CHAT_MESSAGE_EXT = ".jsonl";
