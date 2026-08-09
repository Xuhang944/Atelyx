/**
 * 仓库文件读写 service。
 *
 * 文件化仓库的唯一前端 I/O 出口。
 * 命令对应 `src-tauri/src/commands/vault.rs`，类型对齐 `types/canvas.ts`。
 *
 * text 节点 bodyMd 的剥离/填充在此层组合。
 */
import { invoke } from "@tauri-apps/api/core";
import type { Edge, Node } from "@xyflow/react";
import { CANVAS_SCHEMA } from "@/constants/canvas";
import { dedupeFilename, parentDir, sanitizeFilename } from "@/utils/filename";
import { mapWhiteboardEdges, mapWhiteboardNodes, parseWhiteboard } from "@/utils/whiteboard";
import { tableToSnapshotText } from "@/utils/table";
import { readTableVault } from "@/services/table";
import {
  type CanvasFile,
  type CanvasCreateResult,
  type CanvasFileEdge,
  type CanvasFileNode,
  type CanvasFileRow,
  type CanvasEdge,
  type ConversationFileData,
  type DeleteFolderResult,
  type EditorChatsFile,
  type EditorChatsFileOnDisk,
  type FileTreeNode,
  type Message,
  type TableData,
  type TableFileData,
  type TextData,
  type TextFileData,
  type VaultConfig,
  type VaultInfo,
} from "@/types";

/** 打开仓库：设当前仓库根 + 初始化目录结构。 */
export async function openVault(path: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("open_vault", { path });
}

/** 枚举当前仓库的画布列表（按 updatedAt 倒序）。 */
export async function listCanvasesVault(): Promise<CanvasFileRow[]> {
  return invoke<CanvasFileRow[]>("list_canvases_vault");
}

/** 读 .atlx 文件（按相对仓库根路径，如 `项目A/方案.atlx`）。 */
export async function readCanvasVault(file: string): Promise<CanvasFile> {
  return invoke<CanvasFile>("read_canvas_vault", { file });
}

/** 写 .atlx 文件（整体原子写；title 改了会自动重命名文件到同目录新名）。
 * `file`：画布相对仓库根路径（前端持有，画布任意文件夹存放）。
 * `baseUpdatedAt`：乐观并发基准（加载时的磁盘 updatedAt），磁盘版本更新则 Rust 拒绝。
 * 返回写入后的 updatedAt（秒），前端保存成功后用它同步乐观锁基准。 */
export async function writeCanvasVault(
  canvas: CanvasFile,
  file: string,
  baseUpdatedAt?: number,
): Promise<number> {
  return invoke<number>("write_canvas_vault", { canvas, file, baseUpdatedAt });
}

/** 重命名画布（更新 .atlx 内 title + 同目录重命名文件，按当前文件路径）。 */
export async function renameCanvasVault(file: string, newTitle: string): Promise<void> {
  await invoke("rename_canvas_vault", { file, newTitle });
}

/** 移动画布文件到新路径（跨目录；画布无外部引用，不更新任何 .atlx）。 */
export async function moveCanvasVault(oldFile: string, newFile: string): Promise<void> {
  await invoke("move_canvas_vault", { oldFile, newFile });
}

/** 删除画布 .atlx 文件（不删 笔记/附件，文件可跨画布共享）。 */
export async function deleteCanvasVault(file: string): Promise<void> {
  await invoke("delete_canvas_vault", { file });
}

/** 读 .md 笔记（按相对仓库根路径，如 `笔记/xxx.md`）。 */
export async function readNote(file: string): Promise<string> {
  return invoke<string>("read_note", { file });
}

/** 写 .md 笔记（原子写，自动建父目录）。 */
export async function writeNote(file: string, content: string): Promise<void> {
  await invoke("write_note", { file, content });
}

/**
 * 重命名 .md 笔记 + 扫描所有 .atlx 更新 text 节点 file 引用（链接维护）。
 * @param oldFile 相对仓库根路径，如 `笔记/old.md`
 * @param newFile 相对仓库根路径，如 `笔记/new.md`
 */
export async function renameNote(oldFile: string, newFile: string): Promise<void> {
  await invoke("rename_note", { oldFile, newFile });
}

/** 删除 .md 笔记（不更新 .atlx 引用）。 */
export async function deleteNote(file: string): Promise<void> {
  await invoke("delete_note", { file });
}

/** 删除附件（不更新 .atlx 引用）。 */
export async function deleteAttachment(file: string): Promise<void> {
  await invoke("delete_attachment", { file });
}

/**
 * 复制仓库内文件为同目录副本（纯字节复制；新路径须由调用方 dedupe 防重名）。
 * `.atlx`/`.atb` 的 title/id 更新由调用方经读写命令组合，本命令不做内容特判。
 */
export async function copyVaultFile(oldFile: string, newFile: string): Promise<void> {
  await invoke("copy_vault_file", { oldFile, newFile });
}

/** 复制文件夹为同父目录副本（递归复制全部内容；新路径须由调用方 dedupe 防重名）。 */
export async function copyVaultFolder(oldDir: string, newDir: string): Promise<void> {
  await invoke("copy_vault_folder", { oldDir, newDir });
}

/**
 * 重命名附件 + 扫描所有 .atlx 更新 media 节点 file 引用（链接维护，与 renameNote 对称）。
 * @param oldFile 相对仓库根路径，如 `附件/old.png`
 * @param newFile 相对仓库根路径，如 `附件/new.png`
 */
export async function renameAttachment(oldFile: string, newFile: string): Promise<void> {
  await invoke("rename_attachment", { oldFile, newFile });
}

/** 读附件为 dataURL（`data:<mime>;base64,...`），仅图片扩展名支持；其他抛错由调用方走文本分支。 */
export async function readAttachmentDataUrl(file: string): Promise<string> {
  return invoke<string>("read_attachment_data_url", { file });
}

/** 把系统文件导入仓库 附件/（净化 + 防重名），返回相对路径 `附件/<name>`。 */
export async function importAttachmentVault(src: string, name: string): Promise<string> {
  return invoke<string>("import_attachment_vault", { src, name });
}

/** 读仓库级配置（.atelyx/config.json，不存在返回 {}）。 */
export async function readVaultConfig(): Promise<VaultConfig> {
  return invoke<VaultConfig>("read_vault_config");
}

/** 写仓库级配置（原子写 .atelyx/config.json）。 */
export async function writeVaultConfig(config: VaultConfig): Promise<void> {
  await invoke("write_vault_config", { config });
}

/** 读系统提示词标记列表（.atelyx/prompt-notes.json，不存在/损坏返回空）。 */
export async function readPromptNotes(): Promise<string[]> {
  return invoke<string[]>("read_prompt_notes");
}

/** 写系统提示词标记列表（原子写 .atelyx/prompt-notes.json，独立于 config.json）。 */
export async function writePromptNotes(files: string[]): Promise<void> {
  await invoke("write_prompt_notes", { files });
}

/** 读 AI 对话面板会话索引（.atelyx/editor-chats.json，不存在/损坏返回默认；v1 存量 sessions 可能内嵌 messages，由 store load 迁移）。 */
export async function readEditorChats(): Promise<EditorChatsFileOnDisk> {
  return invoke<EditorChatsFileOnDisk>("read_editor_chats");
}

/** 写 AI 对话面板会话索引（原子写 .atelyx/editor-chats.json，单一全局历史；消息正文在消息 .md）。 */
export async function writeEditorChats(file: EditorChatsFile): Promise<void> {
  await invoke("write_editor_chats", { file });
}

/** 读会话消息正文 .md（.atelyx/对话历史/ 下，路径已校验；文件缺失报错由调用方降级）。 */
export async function readChatMessages(file: string): Promise<string> {
  return invoke<string>("read_chat_messages", { file });
}

/** 写会话消息正文 .md（自动建目录 + 原子写）。 */
export async function writeChatMessages(file: string, content: string): Promise<void> {
  await invoke("write_chat_messages", { file, content });
}

/** 删会话消息正文 .md（幂等）。 */
export async function deleteChatMessages(file: string): Promise<void> {
  await invoke("delete_chat_messages", { file });
}

/** 确保默认仓库已打开（首启 bootstrap：无最近仓库时建默认仓库并打开）。 */
export async function ensureDefaultVault(): Promise<VaultInfo> {
  return invoke<VaultInfo>("ensure_default_vault");
}

/** 新建空画布，返回 { id, file }（file = 相对仓库根路径，前端打开/保存用；dir 空 = 根目录）。 */
export async function createCanvasVault(title: string, dir: string): Promise<CanvasCreateResult> {
  return invoke<CanvasCreateResult>("create_canvas_vault", { title, dir });
}

/** 枚举仓库文件树（文件面板全仓库树；跳过隐藏/排除目录与 `.tmp`）。 */
export async function listVaultTree(): Promise<FileTreeNode[]> {
  return invoke<FileTreeNode[]>("list_vault_tree");
}

/** 新建文件夹（相对仓库根路径，如 `项目A/素材`），自动建父目录；返回相对路径。 */
export async function createFolder(dir: string): Promise<string> {
  return invoke<string>("create_folder", { dir });
}

/** 删除文件夹（相对仓库根路径）。force=false 空目录直接删，非空返回 needsConfirm 供弹窗；确认后 force=true 递归删。 */
export async function deleteFolder(dir: string, force: boolean): Promise<DeleteFolderResult> {
  return invoke<DeleteFolderResult>("delete_folder", { dir, force });
}

/** 重命名文件夹：移动整个目录 + 扫描所有 .atlx 更新位于该目录下文件的引用（`old_dir/` 前缀 → `new_dir/`）。 */
export async function renameFolder(oldDir: string, newDir: string): Promise<void> {
  await invoke("rename_folder", { oldDir, newDir });
}

// ===== 运行时 ↔ 磁盘格式转换 =====

/** 最近写入的 .md 内容缓存（脏检测：仅内容变化才写盘，避免每次保存全量重写全部笔记）。 */
const lastWrittenMd = new Map<string, string>();

/** 加载后的运行时画布（对齐原 loadCanvas 返回结构，供 canvasStore 消费）。 */
export interface RuntimeCanvas {
  /** 磁盘文件内的画布 id（运行时身份；文件名不再含 id） */
  id: string;
  title: string;
  nodes: Node[];
  edges: Edge[];
  messagesByConv: Record<string, Message[]>;
  /** 磁盘版本（updatedAt，乐观并发 baseUpdatedAt 基准）。 */
  updatedAt: number;
}

/**
 * 磁盘 CanvasFile → 运行时格式。
 * - text 节点：读 `.md` 填 `bodyMd`
 * - conversation 节点：提取 `messages` 到 `messagesByConv`，data 剥离 messages
 * - 扁平 x/y → React Flow position
 */
async function canvasFileToRuntime(file: CanvasFile): Promise<RuntimeCanvas> {
  const messagesByConv: Record<string, Message[]> = {};
  const nodes: Node[] = [];
  for (const n of file.nodes) {
    const data: Record<string, unknown> = { ...n.data };
    if (n.type === "text") {
      const td = data as unknown as TextFileData;
      if (td.file) {
        // 笔记节点：正文从 `.md` 实时读取
        try {
          data.bodyMd = await readNote(td.file);
        } catch {
          // 文件不存在，bodyMd 留空（外部编辑删除等情况）
        }
      }
      // 画布内文本节点（无 file）：bodyMd 已随 .atlx 内嵌，无需读文件
    } else if (n.type === "conversation") {
      const cd = data as unknown as ConversationFileData;
      if (cd.messages?.length) {
        messagesByConv[n.id] = cd.messages;
      }
      delete data.messages;
    } else if (n.type === "table") {
      // 表格节点：快照从 `.atb` 实时读取（注入上下文/节点摘要用），读失败标 fileMissing
      const td = data as unknown as TableFileData;
      try {
        const table = await readTableVault(td.file);
        data.snapshot = tableToSnapshotText(table);
      } catch {
        data.fileMissing = true;
      }
    } else if (n.type === "group") {
      // 分组节点：低 zIndex 背景层（磁盘无此字段，运行时注入）
      nodes.push({
        id: n.id,
        type: n.type,
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        zIndex: -1,
        data: n.data as unknown as Node["data"],
      });
      continue;
    }
    nodes.push({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      data: data as Node["data"],
    });
  }
  const edges: CanvasEdge[] = file.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    directed: e.directed,
    linkMode: e.linkMode,
  }));
  return { id: file.id, title: file.title, nodes, edges, messagesByConv, updatedAt: file.updatedAt };
}

/**
 * 运行时 → 磁盘 CanvasFile。
 * - text 节点：写 `.md` + 剥离 bodyMd，data 只留 `{title, file}`
 * - conversation 节点：嵌入 `messagesByConv[id]` 到 `data.messages`
 * - React Flow position → 扁平 x/y
 *
 * `createdAt` 传 0，Rust `write_canvas_vault` 会从原文件保留；`updatedAt` 由 Rust 覆盖为 now。
 */
async function runtimeToCanvasFile(
  canvasId: string,
  title: string,
  nodes: Node[],
  edges: CanvasEdge[],
  messagesByConv: Record<string, Message[]>,
): Promise<CanvasFile> {
  const fileNodes: CanvasFileNode[] = [];
  for (const n of nodes) {
    let data: Record<string, unknown>;
    if (n.type === "text") {
      const td = n.data as unknown as TextData;
      if (td.file) {
        // 笔记节点：脏检测写回 `.md` + 剥离 bodyMd，data 只留 {title, file}（正文在 .md 文件）
        // 脏检测：bodyMd 与上次写入值不同才写盘（外部改 .md 后 bodyMd 未变则不写，保留外部内容）
        if (td.bodyMd !== undefined && lastWrittenMd.get(td.file) !== td.bodyMd) {
          try {
            await writeNote(td.file, td.bodyMd);
            lastWrittenMd.set(td.file, td.bodyMd);
          } catch (e) {
            console.error("写笔记失败", e);
          }
        }
        data = { title: td.title || "未命名", file: td.file };
      } else {
        // 画布内文本节点（无 file）：bodyMd 随 .atlx 内嵌持久化，不落 `.md`（右键「保存为笔记」才写文件）
        data = { title: td.title || "未命名", bodyMd: td.bodyMd ?? "" };
      }
    } else if (n.type === "conversation") {
      data = { ...n.data, messages: messagesByConv[n.id] ?? [] };
    } else if (n.type === "group") {
      // 分组节点：只落 label/color（color 未设置时 undefined 字段随 JSON.stringify 丢弃）
      data = {
        label: (n.data as unknown as { label?: string }).label ?? "分组",
        color: (n.data as unknown as { color?: string }).color,
      };
    } else if (n.type === "link") {
      data = { url: (n.data as unknown as { url?: string }).url ?? "" };
    } else if (n.type === "table") {
      // 表格节点：只落 {title, file}（快照在 .atb 文件，运行时填充/剥离）
      const td = n.data as unknown as TableData;
      data = { title: td.title || "未命名", file: td.file };
    } else {
      // media/search：原样保留（media 的 thumb 暂随 .atlx 持久化，TODO 后续落盘）
      data = { ...n.data };
    }
    fileNodes.push({
      id: n.id,
      type: n.type as CanvasFileNode["type"],
      x: n.position.x,
      y: n.position.y,
      width: n.width,
      height: n.height,
      data: data as unknown as CanvasFileNode["data"],
    });
  }
  const fileEdges: CanvasFileEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    directed: e.directed,
    linkMode: e.linkMode,
    createdAt: 0,
  }));
  return {
    schema: CANVAS_SCHEMA,
    id: canvasId,
    title,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: fileNodes,
    edges: fileEdges,
    createdAt: 0,
    updatedAt: Date.now(),
  };
}

/** 加载画布（运行时格式，供 canvasStore.load 消费）。file = 相对仓库根路径。 */
export async function loadCanvasVault(file: string): Promise<RuntimeCanvas> {
  const f = await readCanvasVault(file);
  return canvasFileToRuntime(f);
}

/** 持久化画布（运行时 → 磁盘，含 text 写 .md + messages 嵌入）。
 * `file`：画布相对仓库根路径；`baseUpdatedAt`：乐观并发基准，透传 Rust 做版本检查。
 * 返回写入后的磁盘 updatedAt（秒）。 */
export async function persistCanvasVault(
  canvasId: string,
  file: string,
  title: string,
  nodes: Node[],
  edges: CanvasEdge[],
  messagesByConv: Record<string, Message[]>,
  baseUpdatedAt: number,
): Promise<number> {
  const canvasFile = await runtimeToCanvasFile(canvasId, title, nodes, edges, messagesByConv);
  return writeCanvasVault(canvasFile, file, baseUpdatedAt);
}

// ===== 外部白板格式（.canvas，只读查看 + 转换为画布）=====

/** 读 .canvas 文件原文（按相对仓库根路径；无写命令——白板格式保持只读）。 */
export async function readWhiteboardVault(file: string): Promise<string> {
  return invoke<string>("read_whiteboard_canvas", { file });
}

/**
 * 加载白板为运行时画布（只读查看用）。
 * 映射规则见 `utils/whiteboard.ts`：id = 文件路径（稳定身份）、title = 文件名去扩展名、
 * 边为无向边。`updatedAt` 为 0（只读不参与乐观锁）。
 */
export async function loadWhiteboardVault(file: string): Promise<RuntimeCanvas> {
  const raw = await readWhiteboardVault(file);
  const whiteboard = parseWhiteboard(raw);
  const nodes = await mapWhiteboardNodes(whiteboard.nodes, {
    readText: readNote,
    readDataUrl: readAttachmentDataUrl,
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = mapWhiteboardEdges(whiteboard.edges, nodeIds);
  const title = file.split("/").pop()?.replace(/\.canvas$/i, "") ?? file;
  return { id: file, title, nodes, edges, messagesByConv: {}, updatedAt: 0 };
}

/**
 * 转换为 .atlx 画布（生成同目录副本，原 .canvas 保留不动，单向转换）。
 * 同名自动加序号（`siblingTitles` = 同目录现有 .atlx 标题，供去重）；
 * 写盘走 `write_canvas_vault`（新文件路径不存在，冲突检查天然通过）。
 * 返回画布行（调用方用于打开）。
 */
export async function convertWhiteboardToAtlx(
  file: string,
  title: string,
  siblingTitles: string[],
): Promise<CanvasFileRow> {
  const raw = await readWhiteboardVault(file);
  const whiteboard = parseWhiteboard(raw);
  const nodes = await mapWhiteboardNodes(whiteboard.nodes, {
    readText: readNote,
    readDataUrl: readAttachmentDataUrl,
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = mapWhiteboardEdges(whiteboard.edges, nodeIds);
  const dir = parentDir(file);
  // 净化后再去重：.canvas 文件名在 Linux 可含非法字符，Rust 侧 write_canvas_vault 会再净化一次，
  // 不先净化会导致「前端打开的路径 ≠ 落盘路径」加载失败
  const actual = dedupeFilename(sanitizeFilename(title) || "白板", siblingTitles);
  const canvasFile = await runtimeToCanvasFile(crypto.randomUUID(), actual, nodes, edges, {});
  const newFile = dir ? `${dir}/${actual}.atlx` : `${actual}.atlx`;
  const updatedAt = await writeCanvasVault(canvasFile, newFile);
  return { id: canvasFile.id, title: actual, file: newFile, updatedAt };
}
