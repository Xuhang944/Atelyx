/**
 * 仓库文件监听分发。
 *
 * 订阅 Rust `watcher.rs` emit 的 `"vault-file-changed"` 事件，按 kind 分发到各 store（事件路径任意文件夹）：
 * - `canvas`：仅当前打开画布（按 file 路径匹配）+ 非自写回放 → setExternalChangePending（工具栏内联条提示重载）；
 *   外部 canvas 事件（非自写）→ appStore.loadList + vaultStore.loadFiles（列表与文件树同步刷新）
 * - `note`：refreshTextContent（try 重读 .md，失败 → markFileMissing）+ vaultStore.loadFiles
 * - `attachment`：refreshMediaContent（try 重读，失败 → markFileMissing）+ vaultStore.loadFiles
 *
 * 挂载点：App.tsx 顶层，`view !== "vaultSelect"` 时全程订阅（工作区）。
 * cleanup 用 mounted flag 防 listen Promise race（订阅未决时组件已卸载）。
 */
import { useEffect } from "react";
import { subscribeVaultFileChanges } from "@/services/watcher";
import { useCanvasStore, isSelfSaveEcho } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import {
  useVaultStore,
  isPendingFolderRenameOldPath,
  isPendingRenameOldPath,
} from "@/stores/vaultStore";
import type { VaultFileChange } from "@/types";

export function useVaultFileWatcher(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let mounted = true;

    void (async () => {
      unlisten = await subscribeVaultFileChanges((c: VaultFileChange) => {
        if (c.kind === "canvas") {
          const store = useCanvasStore.getState();
          // 按文件路径匹配当前画布（画布任意文件夹存放，路径即磁盘身份）；
          // 文件夹重命名期间旧路径删除事件：canvasFile 尚未 remap（Rust 移动目录可能慢于 300ms debounce），
          // 跳过重读防误触 reloadFromDisk 读已不存在的旧路径
          if (
            c.path === store.canvasFile &&
            !isSelfSaveEcho() &&
            !isPendingFolderRenameOldPath(c.path)
          ) {
            if (store.dirty) {
              // 本地有未保存改动：自动重载会丢改动，改为冲突提示让用户决策
              useCanvasStore.setState({ conflictPending: true });
            } else {
              // 无未保存改动：安全自动重载磁盘最新内容
              void useCanvasStore.getState().reloadFromDisk();
            }
          }
          // 外部新建/删除/重命名画布：刷新画布列表 + 文件树（.atlx 行随文件变化增删改名）。
          // 自写回放（isSelfSaveEcho）跳过：画布 CRUD 已在 appStore 内主动刷新两数据源，
          // 纯自动保存只改 mtime、树行不显示时间，无需重扫全仓库
          if (!isSelfSaveEcho()) {
            void useAppStore.getState().loadList();
            void useVaultStore.getState().loadFiles();
          }
          return;
        }

        if (c.kind === "note") {
          // 软件内重命名期间旧路径的删除事件：file 引用已由 vaultStore.renameNote 同步，
          // 跳过重读防误标文件缺失；新路径创建事件正常刷新（同步后节点 file 已指向新路径，命中即刷新）
          if (!isPendingRenameOldPath(c.path) && !isPendingFolderRenameOldPath(c.path)) {
            void useCanvasStore.getState().refreshTextContent(c.path);
            // NoteEditor 感知外部修改：无本地改动实时刷新、有改动提示冲突
            useVaultStore.getState().markNoteExternallyEdited(c.path);
          }
          void useVaultStore.getState().loadFiles();
          return;
        }

        // attachment
        if (!isPendingRenameOldPath(c.path) && !isPendingFolderRenameOldPath(c.path)) {
          void useCanvasStore.getState().refreshMediaContent(c.path);
        }
        void useVaultStore.getState().loadFiles();
      });
      if (!mounted) {
        unlisten?.();
        unlisten = undefined;
      }
    })();

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [enabled]);
}
