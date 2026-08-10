/**
 * 仓库文件监听事件订阅。
 *
 * 包装 Tauri `listen` 订阅 Rust `watcher.rs` emit 的 `"vault-file-changed"` 事件。
 * 无 invoke 封装（watcher 纯事件推送，无命令入口）。
 *
 * 事件由 `vaultStore.startFileWatcher` 消费并分发到各 store（组件层不直连本 service）。
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VaultFileChange } from "@/types";

/**
 * 订阅仓库文件变化事件。返回取消订阅函数。
 * Rust 侧 `watcher.rs::dispatch` emit 同名事件，payload 为 `VaultFileChange`。
 */
export async function subscribeVaultFileChanges(
  handler: (change: VaultFileChange) => void,
): Promise<UnlistenFn> {
  return listen<VaultFileChange>("vault-file-changed", (e) => handler(e.payload));
}
