/**
 * Rust watcher emit 的事件 payload（对齐 `src-tauri/src/watcher.rs::VaultFileChange`）。
 *
 * 不带 action 字段：`notify-debouncer-mini` 不保留 Create/Modify/Remove 语义，
 * 前端用「尝试重读，失败即降级」策略覆盖编辑/删除场景（见 `canvasStore.refreshTextContent`）。
 */
export interface VaultFileChange {
  /** `"note"` | `"attachment"` | `"canvas"` | `"table"`，由扩展名判定（文件任意文件夹存放） */
  kind: "note" | "attachment" | "canvas" | "table";
  /** 相对仓库根路径，如 `"笔记/foo.md"` / `"项目A/bar.atlx"` */
  path: string;
}
