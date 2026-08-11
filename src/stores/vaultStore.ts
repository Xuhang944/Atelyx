/**
 * 仓库文件树状态 + CRUD（自由文件夹结构，兼容通用笔记工具）。
 *
 * 职责：持有全仓库文件树（`list_vault_tree`，跳过隐藏/排除目录），封装文件管理面板用的
 * 新建/重命名/删除，调 `services/vault`。canvases 列表仍由 `appStore` 维护（与画布 CRUD 同源）。
 * watcher 事件到达时调 `loadFiles` 刷新树。
 *
 * 无固定 画布/笔记/附件 目录：`.md` 笔记可在任意文件夹，`file` 字段即相对仓库根路径
 * （如 `项目A/提示词.md`），不用目录名拼接。
 *
 * 分层：组件不直调 service → FileExplorerPanel 用本 store。
 */
import { create } from "zustand";
import {
  createFolder as createFolderSvc,
  copyVaultFile,
  copyVaultFolder,
  deleteAttachment,
  deleteFolder as deleteFolderSvc,
  deleteNote,
  listVaultTree,
  readAttachmentDataUrl as readAttachmentDataUrlSvc,
  readNote,
  renameAttachment as renameAttachmentSvc,
  renameFolder as renameFolderSvc,
  renameNote as renameNoteSvc,
  scanWikiBacklinks as scanWikiBacklinksSvc,
  rebuildInternalLinks as rebuildInternalLinksSvc,
  writeNote,
} from "@/services/vault";
import {
  createTableVault,
  deleteTableVault,
  moveTableVault,
  readTableVault,
  renameTableVault,
  writeTableVault,
} from "@/services/table";
import { subscribeVaultFileChanges } from "@/services/watcher";
import { isSelfSaveEcho, markSelfSave, useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTableStore } from "@/stores/tableStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { baseName, dedupeFilename, parentDir, remapDirPrefix, sanitizeFilename } from "@/utils/filename";
import type { BacklinkRow, DeleteFolderResult, FileTreeNode, RebuildLinksResult, TextData, VaultFileChange } from "@/types";

/**
 * 文本节点 `.md` 文件名约定：`<sanitized-title>.md`（标题即文件名，无 id 后缀）。
 * 同名由 `dedupeFilename` 自动加序号（-2、-3）。重命名同步更新 .atlx 引用。
 */

/**
 * 软件内正在进行的重命名（old → new）。renameNote/renameAttachment 记录，
 * watcher 收到旧路径的删除事件时据此跳过（file 引用已同步，防误标文件缺失）。
 */
let pendingRename: { oldFile: string; newFile: string } | null = null;
export function isPendingRenameOldPath(path: string): boolean {
  return pendingRename?.oldFile === path;
}

/** 最近一次软件内笔记重命名（保留跨渲染周期，供窗口联动区分「重命名」与「真删除」）。 */
let lastNoteRename: { oldFile: string; newFile: string } | null = null;
/** 文件若是最近一次重命名的旧路径，返回新路径；否则 null（真删除/外部变化）。 */
export function lastNoteRenameTarget(oldFile: string): string | null {
  return lastNoteRename?.oldFile === oldFile ? lastNoteRename.newFile : null;
}

/** 最近一次软件内表格重命名/移动（同 lastNoteRename，供表格窗口联动）。 */
let lastTableRename: { oldFile: string; newFile: string } | null = null;
/** 文件若是最近一次表格重命名/移动的旧路径，返回新路径；否则 null。 */
export function lastTableRenameTarget(oldFile: string): string | null {
  return lastTableRename?.oldFile === oldFile ? lastTableRename.newFile : null;
}

/** 软件内正在进行的文件夹重命名（old → new）。watcher 收到旧目录下文件事件时据此跳过（同 pendingRename）。 */
let pendingFolderRename: { oldDir: string; newDir: string } | null = null;
/** 路径是否位于最近一次软件内文件夹重命名的旧目录下（watcher 旧路径事件跳过重读）。 */
export function isPendingFolderRenameOldPath(path: string): boolean {
  return pendingFolderRename !== null && path.startsWith(`${pendingFolderRename.oldDir}/`);
}

/** 最近一次软件内文件夹重命名（保留跨渲染周期，供窗口联动区分「重命名」与「真删除」）。 */
let lastFolderRename: { oldDir: string; newDir: string } | null = null;
/** 文件若位于最近一次文件夹重命名的旧目录下，返回 remap 后新路径；否则 null。 */
export function lastFolderRenameTarget(file: string): string | null {
  if (!lastFolderRename) return null;
  const { oldDir, newDir } = lastFolderRename;
  const prefix = `${oldDir}/`;
  return file.startsWith(prefix) ? `${newDir}/${file.slice(prefix.length)}` : null;
}

/** loadFiles 并发守卫：递增序号，仅最后一次发起者的扫描结果落盘（后台填充与 watcher 触发并发时防旧结果覆盖）。 */
let loadFilesSeq = 0;

/** 文件监听订阅状态（startFileWatcher 幂等启停用）。
 * watcherGen = 订阅代数：每次启/停递增，在途订阅完成时校验代数一致才保留——
 * 防「enable → disable → enable」竞态下旧订阅结果覆盖新订阅、前一个 unlisten 丢失泄漏（双监听常驻）。 */
let watcherActive = false;
let watcherUnlisten: (() => void) | undefined;
let watcherGen = 0;

/**
 * renameNote/moveNote 共用核心：pendingRename 记录 + 服务调用 + 自写抑制 + 乐观锁基准 +
 * 画布节点同步（text file/systemPromptFile）+ 树刷新 + 重命名记录。
 * newTitle 为 null = 移动（title 不变，只改 file）；否则 = 重命名（title 一并更新）。
 */
async function applyNoteFileChange(oldFile: string, newFile: string, newTitle: string | null): Promise<void> {
  pendingRename = { oldFile, newFile };
  try {
    await renameNoteSvc(oldFile, newFile);
    // rename_note 会扫描更新所有 .atlx 的 file 引用（写 .atlx），标记自写抑制 watcher 误报
    markSelfSave();
    // 磁盘 .atlx 已变：同步当前画布乐观锁基准，防重命名后自动保存被「已被外部修改」拒绝
    await useCanvasStore.getState().syncBaseUpdatedAt();
    // 同步当前画布内引用该笔记的节点：text 节点 title + file、conversation 节点 systemPromptFile
    // （磁盘已被 rename_note 更新，此处同步内存防下次保存把旧值回写覆盖；
    //   同步后 watcher 旧路径事件按新路径匹配不到节点，天然不再误标缺失）
    const canvasState = useCanvasStore.getState();
    for (const n of canvasState.nodes) {
      if (n.type === "text" && (n.data as { file?: string }).file === oldFile) {
        canvasState.updateNodeData(
          n.id,
          newTitle !== null ? { title: newTitle, file: newFile } : { file: newFile },
        );
      } else if (
        n.type === "conversation" &&
        (n.data as { systemPromptFile?: string }).systemPromptFile === oldFile
      ) {
        canvasState.updateNodeData(n.id, { systemPromptFile: newFile });
      }
    }
    await useVaultStore.getState().loadFiles();
    // 记录本次重命名（跨渲染保留）：窗口联动据此把打开的笔记切到新文件，而非误判删除关闭
    lastNoteRename = { oldFile, newFile };
    // 系统提示词标记按路径引用：重命名/移动后同步 promptNotes，防标记指向旧路径失效
    await useSettingsStore.getState().remapPromptNote(oldFile, newFile);
    // 「上次打开」的笔记随路径更新（否则下次进入仓库尝试恢复旧路径）
    useUiStateStore.getState().renameLastNote(oldFile, newFile);
  } finally {
    pendingRename = null;
  }
}

/** renameAttachment/moveAttachment 共用核心（media 节点 file 同步，无 title）。 */
async function applyAttachmentFileChange(oldFile: string, newFile: string): Promise<void> {
  pendingRename = { oldFile, newFile };
  try {
    await renameAttachmentSvc(oldFile, newFile);
    // rename_attachment 会扫描更新所有 .atlx 的 media 引用（写 .atlx），标记自写抑制 watcher 误报
    markSelfSave();
    // 磁盘 .atlx 已变：同步当前画布乐观锁基准（同 applyNoteFileChange）
    await useCanvasStore.getState().syncBaseUpdatedAt();
    // 同步当前画布内引用该附件的 media 节点 file（防回写覆盖 + watcher 误标缺失）
    const canvasState = useCanvasStore.getState();
    for (const n of canvasState.nodes) {
      if (n.type === "media" && (n.data as { file?: string }).file === oldFile) {
        canvasState.updateNodeData(n.id, { file: newFile });
      }
    }
    await useVaultStore.getState().loadFiles();
  } finally {
    pendingRename = null;
  }
}

/**
 * renameTable/moveTable 共用核心：pendingRename 记录 + 服务调用 + 自写抑制 + 乐观锁基准 +
 * 画布 table 节点同步（file/title）+ 树刷新 + 重命名记录（模式同 applyNoteFileChange）。
 * 服务命令内部已按 title/新路径扫描更新全部 .atlx 的 table 节点引用。
 */
async function applyTableFileChange(oldFile: string, newFile: string, newTitle: string | null): Promise<void> {
  pendingRename = { oldFile, newFile };
  try {
    if (newTitle !== null) {
      await renameTableVault(oldFile, newTitle);
    } else {
      await moveTableVault(oldFile, newFile);
    }
    markSelfSave();
    await useCanvasStore.getState().syncBaseUpdatedAt();
    // 同步当前画布内引用该表格的 table 节点（防下次保存把旧值回写覆盖 + watcher 误标缺失）
    const canvasState = useCanvasStore.getState();
    for (const n of canvasState.nodes) {
      if (n.type === "table" && (n.data as { file?: string }).file === oldFile) {
        canvasState.updateNodeData(
          n.id,
          newTitle !== null ? { title: newTitle, file: newFile } : { file: newFile },
        );
      }
    }
    await useVaultStore.getState().loadFiles();
    lastTableRename = { oldFile, newFile };
    // 「上次打开」的表格随路径更新（否则下次进入仓库尝试恢复旧路径）
    useUiStateStore.getState().renameLastTable(oldFile, newFile);
  } finally {
    pendingRename = null;
  }
}

/** renameFolder/moveFolder 共用核心：pendingFolderRename 记录 + 服务调用 + 自写抑制 + 画布路径/节点引用同步 + 树刷新。 */
async function applyFolderFileChange(oldDir: string, newDir: string): Promise<void> {
  pendingFolderRename = { oldDir, newDir };
  try {
    await renameFolderSvc(oldDir, newDir);
    // 立即记录本次重命名/移动（跨渲染保留）：目录已移动，后续任何渲染间隙的窗口联动
    // 据此把打开的笔记切到新文件，而非误判删除关闭（放 loadFiles/loadList 之后
    // 会留出 IPC await 间隙，联动 effect 先跑导致笔记窗口被误关）
    lastFolderRename = { oldDir, newDir };
    // rename_folder 会扫描更新所有 .atlx 的目录前缀引用（写 .atlx），标记自写抑制 watcher 误报
    markSelfSave();
    // 当前画布文件若位于该目录下：先同步路径（旧路径已不存在），再同步乐观锁基准
    // （磁盘 .atlx 已被 rename_folder 更新 updatedAt，防下次自动保存被「已被外部修改」拒绝）
    const canvasFile = useCanvasStore.getState().canvasFile;
    if (canvasFile?.startsWith(`${oldDir}/`)) {
      useCanvasStore.setState({ canvasFile: remapDirPrefix(canvasFile, oldDir, newDir) });
      useAppStore.getState().renameCurrentCanvasFile(oldDir, newDir);
    }
    await useCanvasStore.getState().syncBaseUpdatedAt();
    // 同步当前画布内位于该目录下的节点引用（磁盘已被 rename_folder 更新，此处同步内存
    // 防下次保存把旧路径回写覆盖；同步后 watcher 旧路径事件按前缀匹配不到节点，天然不再误标缺失）
    const canvasState = useCanvasStore.getState();
    for (const n of canvasState.nodes) {
      const d = n.data as { file?: string; systemPromptFile?: string };
      if (
        (n.type === "text" || n.type === "media") &&
        d.file &&
        d.file.startsWith(`${oldDir}/`)
      ) {
        canvasState.updateNodeData(n.id, { file: remapDirPrefix(d.file, oldDir, newDir) });
      } else if (
        n.type === "conversation" &&
        d.systemPromptFile &&
        d.systemPromptFile.startsWith(`${oldDir}/`)
      ) {
        canvasState.updateNodeData(n.id, {
          systemPromptFile: remapDirPrefix(d.systemPromptFile, oldDir, newDir),
        });
      }
    }
    // 系统提示词标记 / 展开集合 / 上次打开文件：前缀同步（防标记与恢复指向失效路径）
    await useSettingsStore.getState().remapPromptNotesByDir(oldDir, newDir);
    useUiStateStore.getState().renameByDir(oldDir, newDir);
    await useVaultStore.getState().loadFiles();
    await useAppStore.getState().loadList();
  } finally {
    pendingFolderRename = null;
  }
}

/** 递归提取树中全部 `.md` 笔记（系统提示词下拉 / 笔记存在性检查共用）。 */
function collectMdNotes(nodes: FileTreeNode[]): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const n of nodes) {
    if (n.isDir) {
      out.push(...collectMdNotes(n.children));
    } else if (n.name.toLowerCase().endsWith(".md")) {
      out.push({ name: n.name, file: n.path });
    }
  }
  return out;
}

/** 递归提取树中全部 `.atb` 表格（表格窗口联动 / AI 填行目标选择共用）。 */
function collectAtbTables(nodes: FileTreeNode[]): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const n of nodes) {
    if (n.isDir) {
      out.push(...collectAtbTables(n.children));
    } else if (n.name.toLowerCase().endsWith(".atb")) {
      out.push({ name: n.name, file: n.path });
    }
  }
  return out;
}

/** 按相对路径查树节点（dir = "" 返回根容器）。 */
function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.isDir) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** 取某文件夹下的文件名集合（不含子目录），用于同目录防重名。 */
function siblingFileNames(dir: string): string[] {
  const tree = useVaultStore.getState().tree;
  const node = dir === "" ? { children: tree } : findNode(tree, dir);
  return (node?.children ?? []).filter((c) => !c.isDir).map((c) => c.name);
}

/** 取某文件夹下的文件夹名集合，用于同目录文件夹防重名。 */
function siblingDirNames(dir: string): string[] {
  const tree = useVaultStore.getState().tree;
  const node = dir === "" ? { children: tree } : findNode(tree, dir);
  return (node?.children ?? []).filter((c) => c.isDir).map((c) => c.name);
}

/** 复制文件为同目录副本（dedupe 防重名 + 刷新树），返回新相对路径。duplicateNote/duplicateAttachment 共用。 */
async function applyFileDuplicate(file: string): Promise<string> {
  const dir = parentDir(file);
  const name = dedupeFilename(baseName(file), siblingFileNames(dir));
  const newFile = dir ? `${dir}/${name}` : name;
  await copyVaultFile(file, newFile);
  await useVaultStore.getState().loadFiles();
  return newFile;
}

/** 笔记编辑器保存状态（面积 header 展示用；仅挂载中的编辑器写入、卸载清除）。 */
export type NoteSaveStatus = {
  state: "idle" | "saving" | "saved" | "error";
  loadError: boolean;
};

interface VaultFileState {
  /** 全仓库文件树（递归，跳过隐藏/排除目录与 `.tmp`）。 */
  tree: FileTreeNode[];
  /** 全部 `.md` 笔记（递归提取，file = 相对仓库根路径；系统提示词下拉/存在检查用）。 */
  noteList: { name: string; file: string }[];
  /** 全部 `.atb` 表格（递归提取，file = 相对仓库根路径；表格窗口联动/AI 填行目标选择用）。 */
  tableList: { name: string; file: string }[];
  /** 拉取全仓库文件树（watcher 事件/挂载时调用）。canvases 走 appStore.loadList。 */
  loadFiles: () => Promise<void>;
  /**
   * 新建空 `.md` 笔记，返回相对路径（`<dir>/<name>.md`，dir 空 = 根目录；同名自动加序号）。
   * 调用方拿到路径后可进入 inline 重命名。
   */
  createNote: (title: string, dir?: string) => Promise<string>;
  /**
   * 重命名 `.md`：新路径 = 同目录 `<sanitized-newTitle>.md`（同名自动加序号，排除自身）。
   * 返回实际落盘的文件名（被去重时 ≠ 期望名，调用方据此提示）。
   * 服务端 `rename_note` 会同步更新所有 .atlx 的 text 节点 file 引用。
   */
  renameNote: (oldFile: string, newTitle: string) => Promise<string>;
  /**
   * 移动 `.md` 到目标文件夹（保持文件名，目标同名自动加序号；同目录 = no-op 返回原路径），
   * 返回实际落盘路径（被去重时 ≠ 目标名，调用方据此提示）。同 renameNote 更新引用/树/窗口联动。
   */
  moveNote: (oldFile: string, targetDir: string) => Promise<string>;
  /** 删除 `.md`（不更新 .atlx 引用，断链由前端 TextNode 显示空正文降级）。 */
  deleteNote: (file: string) => Promise<void>;
  /**
   * 复制 `.md` 为同目录副本（同名自动加序号，如 `笔记-2.md`），返回新相对路径。
   * 副本是独立文件，不更新 .atlx 引用、不自动打开。
   */
  duplicateNote: (file: string) => Promise<string>;
  /**
   * 重命名附件：新文件名含扩展名由调用方给。dedupe 防与同目录现有文件重名。
   * 服务端 `rename_attachment` 同步更新所有 .atlx 的 media 节点 file 引用。
   */
  renameAttachment: (oldFile: string, newName: string) => Promise<void>;
  /**
   * 移动附件到目标文件夹（保持文件名，目标同名自动加序号；同目录 = no-op 返回原路径），
   * 返回实际落盘路径。同 renameAttachment 更新 media 引用/树。
   */
  moveAttachment: (oldFile: string, targetDir: string) => Promise<string>;
  /** 删除附件。 */
  deleteAttachment: (file: string) => Promise<void>;
  /** 复制附件为同目录副本（同名自动加序号），返回新相对路径。 */
  duplicateAttachment: (file: string) => Promise<string>;
  /**
   * 新建空 `.atb` 表格（自带「名称」文本字段；同名自动加序号），
   * 返回 { id, file, title }（title 可能被去重改名）。
   */
  createTable: (title: string, dir?: string) => Promise<{ id: string; file: string; title: string }>;
  /**
   * 重命名 `.atb`：新路径 = 同目录 `<sanitized-newTitle>.atb`（同名自动加序号，排除自身）。
   * 返回实际落盘文件名（被去重时 ≠ 期望名，调用方据此提示）。
   * 服务端 `rename_table_vault` 同步更新所有 .atlx 的 table 节点 file 引用 + 文件内 title。
   */
  renameTable: (oldFile: string, newTitle: string) => Promise<string>;
  /** 移动 `.atb` 到目标文件夹（保持文件名，目标同名自动加序号；同目录 = no-op），同步 table 节点引用。 */
  moveTable: (oldFile: string, targetDir: string) => Promise<string>;
  /** 删除 `.atb`（不更新 .atlx 引用，画布 table 节点断链降级）。 */
  deleteTable: (file: string) => Promise<void>;
  /**
   * 复制 `.atb` 为同目录副本：内部 title/id 随新文件名更新（标题即文件名），返回新相对路径。
   * 副本无画布引用，不自动打开。
   */
  duplicateTable: (file: string) => Promise<string>;
  /** 新建文件夹（相对仓库根路径，如 `项目A/素材`，自动建父目录），返回相对路径。 */
  createFolder: (dir: string) => Promise<string>;
  /**
   * 删除文件夹（相对仓库根路径）。force=false 空目录直接删；非空返回 needsConfirm（未删），
   * 调用方弹窗确认后以 force=true 递归删除。删除成功后清理：目录内画布（当前打开的复位画布状态）、
   * 上次打开文件、展开集合，并刷新数据源。
   */
  deleteFolder: (dir: string, force?: boolean) => Promise<DeleteFolderResult>;
  /**
   * 重命名文件夹：新路径 = 同父目录 `<sanitized-newTitle>`（同名自动加序号，排除自身）。
   * 返回实际落盘的目录路径（被去重时 ≠ 期望名，调用方据此提示）。
   * 服务端 `rename_folder` 同步更新所有 .atlx 的目录前缀引用；前端同步当前画布节点引用/打开路径/
   * 提示词标记/UI 状态，并记录 `lastFolderRename` 供窗口联动切到新路径。
   */
  renameFolder: (oldDir: string, newTitle: string) => Promise<string>;
  /**
   * 移动文件夹到目标目录（保持目录名，目标同名自动加序号，排除自身）。返回实际落盘的目录路径。
   * 非法嵌套（移到自身/自身后代）静默 no-op 返回原路径；移到自身祖先 = 原地 no-op。
   * 引用/状态联动同 `renameFolder`（共用 `rename_folder` 服务）。
   */
  moveFolder: (oldDir: string, targetDir: string) => Promise<string>;
  /**
   * 复制文件夹为同父目录副本（递归复制全部内容，同名自动加序号），返回新相对路径。
   * 副本是独立目录，内部相对路径引用随整体复制仍有效，无需链接维护。
   */
  duplicateFolder: (dir: string) => Promise<string>;
  /**
   * 画布内文本节点（无 file）右键「保存为笔记」：落根目录生成 `.md`（净化 + 同名去重）并写入正文，
   * 节点 data.file 置为生成路径转为笔记节点（后续编辑写回 `.md`）。已是笔记节点则 no-op。
   */
  saveTextNodeAsNote: (nodeId: string) => Promise<void>;
  /** 读笔记正文（无画布笔记编辑器用；组件不直调 service，走本 store）。 */
  readNoteContent: (file: string) => Promise<string>;
  /** 查询反链（`[[笔记名]]` 或 `[label](基于仓库的路径)`；Rust 索引缓存，组件不直调 service，走本 store）。 */
  scanWikiBacklinks: (noteName: string, noteFile: string) => Promise<BacklinkRow[]>;
  /** 一键重建内部链接（设置 → 编辑器入口；Rust 字节级跨度改写，组件不直调 service，走本 store）。 */
  rebuildInternalLinks: () => Promise<RebuildLinksResult>;
  /** 读附件为 dataURL（仅图片扩展名；失败抛错由调用方降级）。组件不直调 service，走本 store。 */
  readAttachmentDataUrl: (file: string) => Promise<string>;
  /** 写回笔记正文并刷新文件树（mtime 变化即时反映到面板）。 */
  saveNoteContent: (file: string, content: string) => Promise<void>;
  /** 外部修改的笔记（file → 递增序号）。NoteEditor 订阅感知外部变更：无本地改动时实时刷新，有改动时提示冲突。 */
  externalNoteEdits: Record<string, number>;
  /** watcher 收到 `.md` 外部变化事件时 bump 序号（软件内重命名旧路径事件由调用方跳过）。 */
  markNoteExternallyEdited: (file: string) => void;
  /** 笔记编辑器保存状态（file → 状态；面积 header 读取，编辑器卸载/切文件时清除）。 */
  noteSaveStates: Record<string, NoteSaveStatus>;
  /** 更新笔记编辑器保存状态（null = 清除）。 */
  setNoteSaveState: (file: string, status: NoteSaveStatus | null) => void;
  /** 笔记编辑器冲突状态（file → 是否冲突；面积 header 读取，编辑器卸载/切文件时清除）。 */
  noteConflicts: Record<string, boolean>;
  /** 更新笔记编辑器冲突状态（false = 清除）。 */
  setNoteConflict: (file: string, conflict: boolean) => void;
  /** 笔记冲突解决请求（file → 递增序号 + 解决方式；面积 header 按钮发请求，NoteEditor 订阅执行）。 */
  noteConflictResolveReq: Record<string, { seq: number; keepLocal: boolean }>;
  /** 请求解决笔记冲突（keepLocal = 保留本地并保存；false = 重新加载丢弃本地）。 */
  resolveNoteConflict: (file: string, keepLocal: boolean) => void;
  /** 清除笔记冲突解决请求（编辑器卸载时调用，防残留）。 */
  clearNoteConflictResolveReq: (file: string) => void;
  /**
   * 仓库文件监听启停（幂等）：订阅 Rust watcher 事件并按 kind 分发到各 store。
   * 工作区挂载时 enable（App.tsx 调），回启动页 disable。分层：订阅副作用归 store，组件不直连 service。
   */
  startFileWatcher: (enabled: boolean) => void;
}

export const useVaultStore = create<VaultFileState>((set, get) => ({
  tree: [],
  noteList: [],
  tableList: [],

  loadFiles: async () => {
    const seq = ++loadFilesSeq;
    try {
      const tree = await listVaultTree();
      if (seq !== loadFilesSeq) return;
      set({ tree, noteList: collectMdNotes(tree), tableList: collectAtbTables(tree) });
    } catch (e) {
      console.error("加载仓库文件树失败", e);
    }
  },

  createNote: async (title, dir = "") => {
    const base = sanitizeFilename(title) || "未命名";
    // 同名自动加序号（-2、-3），保证同目录不重名
    const name = dedupeFilename(`${base}.md`, siblingFileNames(dir));
    const file = dir ? `${dir}/${name}` : name;
    await writeNote(file, "");
    await get().loadFiles();
    return file;
  },

  renameNote: async (oldFile, newTitle) => {
    const oldDir = parentDir(oldFile);
    const base = sanitizeFilename(newTitle) || "未命名";
    // 同名自动加序号（排除自身，改名到原名不重复）
    const newName = dedupeFilename(
      `${base}.md`,
      siblingFileNames(oldDir).filter((n) => n !== baseName(oldFile)),
    );
    const newFile = oldDir ? `${oldDir}/${newName}` : newName;
    if (newFile === oldFile) return newFile;
    await applyNoteFileChange(oldFile, newFile, newTitle);
    return newFile;
  },

  moveNote: async (oldFile, targetDir) => {
    // 保持文件名，目标文件夹同名自动加序号（排除自身 = 同目录移动 no-op）
    const name = baseName(oldFile);
    const existing = siblingFileNames(targetDir).filter(
      (n) => (targetDir ? `${targetDir}/${n}` : n) !== oldFile,
    );
    const safe = dedupeFilename(name, existing);
    const newFile = targetDir ? `${targetDir}/${safe}` : safe;
    if (newFile === oldFile) return oldFile;
    await applyNoteFileChange(oldFile, newFile, null);
    return newFile;
  },

  deleteNote: async (file) => {
    await deleteNote(file);
    // 删除的是「上次打开」的笔记：清空 uiState 记录（否则下次进入仓库尝试恢复已删文件）
    if (useUiStateStore.getState().lastNoteFile === file) {
      useUiStateStore.getState().closeNote();
    }
    await get().loadFiles();
  },

  duplicateNote: async (file) => {
    // 同目录复制，同名自动加序号（-2、-3）；副本不自动打开、不更新引用
    return applyFileDuplicate(file);
  },

  renameAttachment: async (oldFile, newName) => {
    const oldDir = parentDir(oldFile);
    const existing = siblingFileNames(oldDir).filter(
      (n) => (oldDir ? `${oldDir}/${n}` : n) !== oldFile,
    );
    const safe = dedupeFilename(newName.trim() || "未命名", existing);
    const newFile = oldDir ? `${oldDir}/${safe}` : safe;
    if (newFile === oldFile) return;
    await applyAttachmentFileChange(oldFile, newFile);
  },

  moveAttachment: async (oldFile, targetDir) => {
    // 保持文件名，目标文件夹同名自动加序号（排除自身 = 同目录移动 no-op）
    const name = baseName(oldFile);
    const existing = siblingFileNames(targetDir).filter(
      (n) => (targetDir ? `${targetDir}/${n}` : n) !== oldFile,
    );
    const safe = dedupeFilename(name, existing);
    const newFile = targetDir ? `${targetDir}/${safe}` : safe;
    if (newFile === oldFile) return oldFile;
    await applyAttachmentFileChange(oldFile, newFile);
    return newFile;
  },

  deleteAttachment: async (file) => {
    await deleteAttachment(file);
    await get().loadFiles();
  },

  duplicateAttachment: async (file) => {
    return applyFileDuplicate(file);
  },

  createTable: async (title, dir = "") => {
    const base = sanitizeFilename(title) || "未命名表格";
    // 同名自动加序号（-2、-3），保证同目录不重名
    const name = dedupeFilename(`${base}.atb`, siblingFileNames(dir));
    const actual = name.replace(/\.atb$/i, "");
    const { id, file } = await createTableVault(actual, dir);
    await get().loadFiles();
    return { id, file, title: actual };
  },

  renameTable: async (oldFile, newTitle) => {
    const oldDir = parentDir(oldFile);
    const base = sanitizeFilename(newTitle) || "未命名表格";
    // 同名自动加序号（排除自身，改名到原名不重复）
    const newName = dedupeFilename(
      `${base}.atb`,
      siblingFileNames(oldDir).filter((n) => n !== baseName(oldFile)),
    );
    const newFile = oldDir ? `${oldDir}/${newName}` : newName;
    if (newFile === oldFile) return newFile;
    await applyTableFileChange(oldFile, newFile, newName.replace(/\.atb$/i, ""));
    return newFile;
  },

  moveTable: async (oldFile, targetDir) => {
    const name = baseName(oldFile);
    const existing = siblingFileNames(targetDir).filter(
      (n) => (targetDir ? `${targetDir}/${n}` : n) !== oldFile,
    );
    const safe = dedupeFilename(name, existing);
    const newFile = targetDir ? `${targetDir}/${safe}` : safe;
    if (newFile === oldFile) return oldFile;
    await applyTableFileChange(oldFile, newFile, null);
    return newFile;
  },

  deleteTable: async (file) => {
    await deleteTableVault(file);
    // 删除的是「上次打开」的表格：清空 uiState 记录（否则下次进入仓库尝试恢复已删文件）
    if (useUiStateStore.getState().lastTableFile === file) {
      useUiStateStore.getState().closeTable();
    }
    await get().loadFiles();
  },

  duplicateTable: async (file) => {
    // 读原表 → 重写 title/id 落同目录新文件（「标题即文件名」规范，写盘路径由 title 决定）
    const table = await readTableVault(file);
    const dir = parentDir(file);
    const name = dedupeFilename(baseName(file), siblingFileNames(dir));
    const newFile = dir ? `${dir}/${name}` : name;
    const newTitle = name.replace(/\.atb$/i, "");
    await writeTableVault(
      { ...table, id: crypto.randomUUID(), title: newTitle },
      newFile,
    );
    await get().loadFiles();
    return newFile;
  },

  createFolder: async (dir) => {
    await createFolderSvc(dir);
    await get().loadFiles();
    return dir;
  },

  deleteFolder: async (dir, force = false) => {
    const result = await deleteFolderSvc(dir, force);
    if (!result.deleted) return result;
    // 目录内画布全部消失：当前打开的画布在目录内 → 清空运行时状态 + 画布槽/标签（同 deleteCanvas 联动）
    const appStore = useAppStore.getState();
    const hadCanvases = appStore.closeCanvasIfInDir(dir);
    // 删除的是「上次打开」的笔记：清空 uiState 记录（否则下次进入仓库尝试恢复已删文件）
    if (useUiStateStore.getState().lastNoteFile?.startsWith(`${dir}/`)) {
      useUiStateStore.getState().closeNote();
    }
    // 展开集合清理该目录及子目录条目（残留条目无害但保持整洁）
    useUiStateStore.getState().removeExpandedByDir(dir);
    await get().loadFiles();
    if (hadCanvases) await appStore.loadList();
    return result;
  },

  renameFolder: async (oldDir, newTitle) => {
    const oldParent = parentDir(oldDir);
    const base = sanitizeFilename(newTitle) || "未命名";
    // 同名自动加序号（排除自身，改名到原名不重复）
    const newName = dedupeFilename(
      base,
      siblingDirNames(oldParent).filter((n) => (oldParent ? `${oldParent}/${n}` : n) !== oldDir),
    );
    const newDir = oldParent ? `${oldParent}/${newName}` : newName;
    if (newDir === oldDir) return newDir;
    await applyFolderFileChange(oldDir, newDir);
    return newDir;
  },

  moveFolder: async (oldDir, targetDir) => {
    // 保持目录名，目标文件夹同名自动加序号（排除自身 = 同目录移动 no-op）
    const name = baseName(oldDir);
    const existing = siblingDirNames(targetDir).filter(
      (n) => (targetDir ? `${targetDir}/${n}` : n) !== oldDir,
    );
    const safe = dedupeFilename(name, existing);
    const newDir = targetDir ? `${targetDir}/${safe}` : safe;
    if (newDir === oldDir) return oldDir;
    // 非法嵌套（移到自身/自身后代）静默 no-op：目录移进自己内部会让自己消失（各平台行为不一致）
    if (targetDir === oldDir || targetDir.startsWith(`${oldDir}/`)) return oldDir;
    await applyFolderFileChange(oldDir, newDir);
    return newDir;
  },

  duplicateFolder: async (dir) => {
    const parent = parentDir(dir);
    const name = dedupeFilename(baseName(dir), siblingDirNames(parent));
    const newDir = parent ? `${parent}/${name}` : name;
    await copyVaultFolder(dir, newDir);
    await get().loadFiles();
    // 目录内可能含 .atlx：画布列表同步刷新（否则文件面板画布区不显示副本画布）
    await useAppStore.getState().loadList();
    return newDir;
  },

  saveTextNodeAsNote: async (nodeId) => {
    const canvasState = useCanvasStore.getState();
    const node = canvasState.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "text") return;
    const d = node.data as unknown as TextData;
    if (d.file) return; // 已是笔记节点
    // 结构转换（画布内文本 → 笔记节点）入 undo 栈：Ctrl+Z 可还原为画布内文本节点。
    // 已知语义：撤销只回滚内存态，不删除已落盘的 .md 文件（文件残留由用户手动清理）
    canvasState.pushUndo();
    // createNote 生成文件名（title 净化 + 同目录去重）并建空文件；再写正文；成功后节点转笔记引用
    const file = await get().createNote(d.title || "未命名");
    try {
      await writeNote(file, d.bodyMd ?? "");
    } catch (e) {
      // 写正文失败：回滚已建的空文件（防根目录残留孤儿 .md），节点保持画布内文本不转引用
      console.error("保存为笔记失败", e);
      await deleteNote(file).catch(() => {});
      throw e;
    }
    await get().loadFiles();
    canvasState.updateNodeData(nodeId, { file });
  },

  readNoteContent: async (file) => readNote(file),
  scanWikiBacklinks: (noteName, noteFile) => scanWikiBacklinksSvc(noteName, noteFile),
  rebuildInternalLinks: () => rebuildInternalLinksSvc(),
  readAttachmentDataUrl: (file) => readAttachmentDataUrlSvc(file),

  saveNoteContent: async (file, content) => {
    await writeNote(file, content);
    await get().loadFiles();
  },

  externalNoteEdits: {},

  markNoteExternallyEdited: (file) =>
    set((s) => ({
      externalNoteEdits: { ...s.externalNoteEdits, [file]: (s.externalNoteEdits[file] ?? 0) + 1 },
    })),

  noteSaveStates: {},

  setNoteSaveState: (file, status) =>
    set((s) => {
      if (status === null) {
        const next = { ...s.noteSaveStates };
        delete next[file];
        return { noteSaveStates: next };
      }
      return { noteSaveStates: { ...s.noteSaveStates, [file]: status } };
    }),

  noteConflicts: {},

  setNoteConflict: (file, conflict) =>
    set((s) => {
      const next = { ...s.noteConflicts };
      if (conflict) next[file] = true;
      else delete next[file];
      return { noteConflicts: next };
    }),

  noteConflictResolveReq: {},

  resolveNoteConflict: (file, keepLocal) =>
    set((s) => ({
      noteConflictResolveReq: {
        ...s.noteConflictResolveReq,
        [file]: { seq: (s.noteConflictResolveReq[file]?.seq ?? 0) + 1, keepLocal },
      },
    })),

  clearNoteConflictResolveReq: (file) =>
    set((s) => {
      const next = { ...s.noteConflictResolveReq };
      delete next[file];
      return { noteConflictResolveReq: next };
    }),

  startFileWatcher: (enabled) => {
    // 幂等：同一状态重复调用不动作（App 的 view effect 可能多次触发相同值）
    if (enabled === watcherActive) return;
    if (!enabled) {
      watcherGen++;
      watcherUnlisten?.();
      watcherUnlisten = undefined;
      watcherActive = false;
      return;
    }
    watcherActive = true;
    const gen = ++watcherGen;
    // 订阅是异步的（listen 往返），期间若被 disable/重新 enable（gen 已递增），
    // 完成时按代数丢弃本次订阅——否则旧订阅覆盖 watcherUnlisten 导致前一个泄漏常驻
    void (async () => {
      const unlisten = await subscribeVaultFileChanges((c: VaultFileChange) => {
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
            void get().loadFiles();
          }
          return;
        }

        if (c.kind === "note") {
          // 软件内重命名期间旧路径的删除事件：file 引用已由 renameNote 同步，
          // 跳过重读防误标文件缺失；新路径创建事件正常刷新（同步后节点 file 已指向新路径，命中即刷新）
          if (!isPendingRenameOldPath(c.path) && !isPendingFolderRenameOldPath(c.path)) {
            void useCanvasStore.getState().refreshTextContent(c.path);
            // NoteEditor 感知外部修改：无本地改动实时刷新、有改动提示冲突
            get().markNoteExternallyEdited(c.path);
          }
          void get().loadFiles();
          return;
        }

        if (c.kind === "table") {
          // 与 canvas 事件同策略：当前打开的表格被外部修改 → 无脏静默重载、有脏冲突提示
          // （软件内重命名/自写回放跳过，防误触发）
          const store = useTableStore.getState();
          if (
            c.path === store.tableFile &&
            !isSelfSaveEcho() &&
            !isPendingRenameOldPath(c.path) &&
            !isPendingFolderRenameOldPath(c.path)
          ) {
            if (store.dirty) {
              useTableStore.setState({ conflictPending: true });
            } else {
              void useTableStore.getState().reloadFromDisk();
            }
          }
          // 画布上引用该表格的节点：silent 刷新快照（与 note 事件刷新 text 节点对称）
          if (!isPendingRenameOldPath(c.path) && !isPendingFolderRenameOldPath(c.path)) {
            void useCanvasStore.getState().refreshTableContent(c.path);
          }
          void get().loadFiles();
          return;
        }

        // attachment
        if (!isPendingRenameOldPath(c.path) && !isPendingFolderRenameOldPath(c.path)) {
          void useCanvasStore.getState().refreshMediaContent(c.path);
        }
        void get().loadFiles();
      });
      if (gen !== watcherGen) {
        unlisten();
      } else {
        watcherUnlisten = unlisten;
      }
    })();
  },
}));
