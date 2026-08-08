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
  deleteAttachment,
  deleteFolder as deleteFolderSvc,
  deleteNote,
  listVaultTree,
  readAttachmentDataUrl as readAttachmentDataUrlSvc,
  readNote,
  renameAttachment as renameAttachmentSvc,
  renameFolder as renameFolderSvc,
  renameNote as renameNoteSvc,
  writeNote,
} from "@/services/vault";
import { markSelfSave, useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStateStore } from "@/stores/uiStateStore";
import { dedupeFilename, parentDir, remapDirPrefix, sanitizeFilename } from "@/utils/filename";
import type { DeleteFolderResult, FileTreeNode, TextData } from "@/types";

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

interface VaultFileState {
  /** 全仓库文件树（递归，跳过隐藏/排除目录与 `.tmp`）。 */
  tree: FileTreeNode[];
  /** 全部 `.md` 笔记（递归提取，file = 相对仓库根路径；系统提示词下拉/存在检查用）。 */
  noteList: { name: string; file: string }[];
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
   * 画布内文本节点（无 file）右键「保存为笔记」：落根目录生成 `.md`（净化 + 同名去重）并写入正文，
   * 节点 data.file 置为生成路径转为笔记节点（后续编辑写回 `.md`）。已是笔记节点则 no-op。
   */
  saveTextNodeAsNote: (nodeId: string) => Promise<void>;
  /** 读笔记正文（无画布笔记编辑器用；组件不直调 service，走本 store）。 */
  readNoteContent: (file: string) => Promise<string>;
  /** 读附件为 dataURL（仅图片扩展名；失败抛错由调用方降级）。组件不直调 service，走本 store。 */
  readAttachmentDataUrl: (file: string) => Promise<string>;
  /** 写回笔记正文并刷新文件树（mtime 变化即时反映到面板）。 */
  saveNoteContent: (file: string, content: string) => Promise<void>;
  /** 外部修改的笔记（file → 递增序号）。NoteEditor 订阅感知外部变更：无本地改动时实时刷新，有改动时提示冲突。 */
  externalNoteEdits: Record<string, number>;
  /** watcher 收到 `.md` 外部变化事件时 bump 序号（软件内重命名旧路径事件由调用方跳过）。 */
  markNoteExternallyEdited: (file: string) => void;
}

export const useVaultStore = create<VaultFileState>((set, get) => ({
  tree: [],
  noteList: [],

  loadFiles: async () => {
    const seq = ++loadFilesSeq;
    try {
      const tree = await listVaultTree();
      if (seq !== loadFilesSeq) return;
      set({ tree, noteList: collectMdNotes(tree) });
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
      siblingFileNames(oldDir).filter((n) => n !== oldFile.split("/").pop()),
    );
    const newFile = oldDir ? `${oldDir}/${newName}` : newName;
    if (newFile === oldFile) return newFile;
    await applyNoteFileChange(oldFile, newFile, newTitle);
    return newFile;
  },

  moveNote: async (oldFile, targetDir) => {
    // 保持文件名，目标文件夹同名自动加序号（排除自身 = 同目录移动 no-op）
    const name = oldFile.split("/").pop() ?? oldFile;
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
    const name = oldFile.split("/").pop() ?? oldFile;
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
    pendingFolderRename = { oldDir, newDir };
    try {
      await renameFolderSvc(oldDir, newDir);
      // 立即记录本次重命名（跨渲染保留）：目录已移动，后续任何渲染间隙的窗口联动
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
      await get().loadFiles();
      await useAppStore.getState().loadList();
      return newDir;
    } finally {
      pendingFolderRename = null;
    }
  },

  saveTextNodeAsNote: async (nodeId) => {
    const canvasState = useCanvasStore.getState();
    const node = canvasState.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "text") return;
    const d = node.data as unknown as TextData;
    if (d.file) return; // 已是笔记节点
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
}));
