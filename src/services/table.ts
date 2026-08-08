/**
 * 多维表格（.atb）文件读写 service。
 *
 * 命令对应 `src-tauri/src/commands/table.rs`，类型对齐 `types/table.ts`。
 * 重命名/移动由 Rust 扫描所有 .atlx 同步 table 节点 file 引用（链接维护）。
 */
import { invoke } from "@tauri-apps/api/core";
import type { TableCreateResult, TableFile } from "@/types";

/** 新建空表格（自带一个「名称」文本字段），返回 { id, file }（dir 空 = 根目录）。 */
export async function createTableVault(title: string, dir: string): Promise<TableCreateResult> {
  return invoke<TableCreateResult>("create_table_vault", { title, dir });
}

/** 读 .atb 文件（按相对仓库根路径）。 */
export async function readTableVault(file: string): Promise<TableFile> {
  return invoke<TableFile>("read_table_vault", { file });
}

/** 写 .atb 文件（原子写；title 变更自动改文件名并同步画布引用）。
 * `baseUpdatedAt`：乐观并发基准（加载时的磁盘 updatedAt），磁盘版本更新则 Rust 拒绝。
 * 返回写入后的 updatedAt（秒），前端保存成功后用它同步乐观锁基准。 */
export async function writeTableVault(
  table: TableFile,
  file: string,
  baseUpdatedAt?: number,
): Promise<number> {
  return invoke<number>("write_table_vault", { table, file, baseUpdatedAt });
}

/** 重命名表格（更新 .atb 内 title + 同目录改文件名 + 同步画布 table 节点引用）。 */
export async function renameTableVault(file: string, newTitle: string): Promise<void> {
  await invoke("rename_table_vault", { file, newTitle });
}

/** 移动表格文件到新路径（跨目录 + 同步画布 table 节点引用）。 */
export async function moveTableVault(oldFile: string, newFile: string): Promise<void> {
  await invoke("move_table_vault", { oldFile, newFile });
}

/** 删除表格文件（不更新 .atlx 引用，画布 table 节点断链降级）。 */
export async function deleteTableVault(file: string): Promise<void> {
  await invoke("delete_table_vault", { file });
}

/** 读系统文件选择器选中的图片为 dataURL（多图单元格导入用，任意绝对路径）。 */
export async function readExternalImageDataUrl(src: string): Promise<string> {
  return invoke<string>("read_external_image_data_url", { src });
}

/** 导出表格为 .xlsx（目标路径来自系统保存对话框）。 */
export async function exportTableXlsx(table: TableFile, targetPath: string): Promise<void> {
  await invoke("export_table_xlsx", { table, targetPath });
}
