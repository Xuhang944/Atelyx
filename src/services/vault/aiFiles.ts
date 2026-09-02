/**
 * AI 文件工具的仓库能力（read_file / edit_file / write_file 的落地）。
 *
 * - `readVaultFile`/`writeVaultFile`：读/写仓库内**任意文本文件**（安全边界 = 仓库根，
 *   Rust `safe_join` 校验 + 原子写 + 自动建父目录）。
 * - `editVaultFile`：行级修改（oldText 唯一精确匹配、块间不重叠，全部校验通过后统一替换），
 *   按路径定位（通用，不只 .md），复用笔记行级替换的校验语义。
 */
import { invoke } from "@tauri-apps/api/core";
import { READ_WINDOW_DEFAULT_LINES } from "@/constants/tools";
import type { GlobVaultResult, GrepVaultResult, ListDirResult, ReadWindowResult } from "@/types";

/** 读仓库内任意文本文件（相对仓库根路径；超出仓库根/不存在抛错，由调用方降级）。 */
export async function readVaultFile(file: string): Promise<string> {
  return invoke<string>("read_vault_file", { file });
}

/** 分页读仓库内任意文本文件：返回带绝对行号的窗口（offset 1-based 默认 1；limit 默认 2000 行）。
 * 供 read_file 工具用——大文件可分段读完，不硬拒。 */
export async function readVaultFileWindow(
  file: string,
  opts?: { offset?: number; limit?: number },
): Promise<ReadWindowResult> {
  return invoke<ReadWindowResult>("read_vault_file_window", {
    file,
    offset: opts?.offset ?? 1,
    limit: opts?.limit ?? READ_WINDOW_DEFAULT_LINES,
  });
}

/**
 * 写仓库内任意文本文件（原子写 + 自动建父目录）。
 * 注意：不登记 `.md` 磁盘基线（lastWrittenMd）——AI 写入对冲突/刷新模型按「外部写入」处理：
 * 打开中的笔记干净态静默刷新、有未保存改动弹冲突条（防静默覆盖 Agent 编辑）；
 * 画布文本节点刷新由 refreshTextContent 的 lastSaved 判定兜底（登记基线会把「磁盘新于
 * 节点内存」误判为自写回波，导致节点陈旧、下次画布保存回写旧正文覆盖）。
 */
export async function writeVaultFile(file: string, content: string): Promise<void> {
  await invoke("write_vault_file", { file, content });
}

interface FileEditEntry {
  oldText: string;
  newText: string;
}

/** glob 检索（AI glob 工具后端）：按模式返回相对仓库根的文件路径列表（修改时间升序、上限内联 + total）。 */
export async function globVault(
  pattern: string,
  opts?: { path?: string },
): Promise<GlobVaultResult> {
  return invoke<GlobVaultResult>("glob_vault", { pattern, path: opts?.path });
}

/** grep 检索（AI grep 工具后端）：正则搜仓库文件内容，返回匹配行（上限内联 + total）。 */
export async function grepVault(
  pattern: string,
  opts?: { path?: string; include?: string },
): Promise<GrepVaultResult> {
  return invoke<GrepVaultResult>("grep_vault", {
    pattern,
    path: opts?.path,
    include: opts?.include,
  });
}

/** 单层列出目录条目（AI list_dir 工具后端）：目录在前、含隐藏项，子目录带子项数。dir 缺省 = 仓库根。 */
export async function listVaultDir(dir?: string): Promise<ListDirResult> {
  return invoke<ListDirResult>("list_vault_dir", { dir: dir ?? "" });
}

/**
 * 行级修改仓库内任意文本文件：每项 oldText 须在原文唯一精确匹配且块间不重叠，全部通过后统一替换（原子写）。
 * 返回 { ok, summary }（失败给具体原因，不抛断整轮）。
 */
export async function editVaultFile(
  file: string,
  edits: FileEditEntry[],
): Promise<{ ok: boolean; summary: string }> {
  const original = await readVaultFile(file).catch(() => null);
  if (original === null) return { ok: false, summary: `读取文件「${file}」失败` };

  const matches: Array<{ edit: FileEditEntry; index: number }> = [];
  for (const edit of edits) {
    const preview = edit.oldText.length > 30 ? `${edit.oldText.slice(0, 30)}…` : edit.oldText;
    const index = original.indexOf(edit.oldText);
    if (index < 0) return { ok: false, summary: `原文片段未找到：「${preview}」` };
    if (original.indexOf(edit.oldText, index + 1) >= 0) {
      return { ok: false, summary: `原文片段不唯一：「${preview}」——请扩充上下文使其唯一` };
    }
    matches.push({ edit, index });
  }
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    if (matches[i].index < prev.index + prev.edit.oldText.length) {
      return { ok: false, summary: "替换片段重叠，请合并为一块" };
    }
  }

  let result = original;
  // 从后往前替换防位置漂移（每块在原始文本中的位置已记录，全量校验通过）
  for (let i = matches.length - 1; i >= 0; i--) {
    const { edit, index } = matches[i];
    result = result.slice(0, index) + edit.newText + result.slice(index + edit.oldText.length);
  }
  try {
    await writeVaultFile(file, result);
  } catch (e) {
    return { ok: false, summary: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, summary: `修改文件「${file}」${edits.length} 处` };
}
