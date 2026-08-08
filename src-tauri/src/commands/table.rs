//! 多维表格（.atb）文件命令。
//!
//! 命名约定同 .atlx：`<sanitized-title>.atb`（标题即文件名，任意文件夹，同名自动加序号）。
//! 重命名/移动会扫描所有 .atlx 更新 table 节点 file 引用（链接维护，
//! 复用 `commands/vault.rs` 的 collect/flush 扫描函数，事务模式与 rename_note 对称）。

use base64::Engine;
use chrono::Utc;
use nanoid::nanoid;
use serde::Serialize;
use tauri::State;

use crate::commands::vault::{collect_table_ref_updates, flush_canvas_updates, mime_from_ext};
use crate::vault::{
    delete_vault_file, read_table_file, rename_note_file, safe_join, sanitize_filename,
    write_table_file, TableField, TableFile, VaultState, TABLE_SCHEMA,
};

/// `create_table_vault` 返回值：id（运行时身份）+ file（磁盘定位）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCreateResult {
    pub id: String,
    pub file: String,
}

/// 新建空表格（自带一个「名称」文本字段，空白表无字段难用），返回 `{ id, file }`。
#[tauri::command]
pub fn create_table_vault(
    title: String,
    dir: String,
    state: State<'_, VaultState>,
) -> Result<TableCreateResult, String> {
    let root = state.root()?;
    let id = nanoid!();
    let now = Utc::now().timestamp();
    let table = TableFile {
        schema: TABLE_SCHEMA.to_string(),
        id: id.clone(),
        title: title.clone(),
        fields: vec![TableField {
            id: nanoid!(),
            name: "名称".to_string(),
            field_type: "text".to_string(),
            options: None,
            width: None,
        }],
        rows: vec![],
        created_at: now,
        updated_at: now,
    };
    let filename = format!("{}.atb", sanitize_filename(&title));
    let rel = if dir.is_empty() {
        filename
    } else {
        format!("{dir}/{filename}")
    };
    let path = safe_join(&root, &rel, true)?;
    // 后端兜底：同名表格已存在则拒绝（前端 dedupe 是正常路径，此处防绕过/同步盘合并覆盖）
    if path.exists() {
        return Err(format!("表格名冲突：{}", title));
    }
    write_table_file(&path, &table)?;
    Ok(TableCreateResult { id, file: rel })
}

/// 读 .atb 文件（按相对仓库根路径，如 `项目A/分镜.atb`）。
#[tauri::command]
pub fn read_table_vault(file: String, state: State<'_, VaultState>) -> Result<TableFile, String> {
    let root = state.root()?;
    let path = safe_join(&root, &file, false)?;
    read_table_file(&path)
}

/// 写 .atb 文件（整体原子写；title 改了会自动重命名文件到同目录新名并同步画布 table 节点引用）。
/// `base_updated_at`：乐观并发基准（加载时的磁盘 updatedAt），磁盘版本更新则拒绝写（None = 不检查）。
/// 返回写入的 updated_at，前端保存成功后同步乐观锁基准。
#[tauri::command]
pub fn write_table_vault(
    mut table: TableFile,
    file: String,
    base_updated_at: Option<i64>,
    state: State<'_, VaultState>,
) -> Result<i64, String> {
    let root = state.root()?;
    let old_path = safe_join(&root, &file, false)?;
    let parent = old_path
        .parent()
        .ok_or_else(|| format!("非法路径：{}", file))?;
    let new_path = parent.join(format!("{}.atb", sanitize_filename(&table.title)));
    // 新路径已存在且 id 不同（前端 dedupe 被绕过/同步盘合并）：拒绝覆盖
    if new_path.exists() {
        if let Ok(existing) = read_table_file(&new_path) {
            if existing.id != table.id {
                return Err(format!("表格名冲突：另一表格已使用名称「{}」", table.title));
            }
        }
    }
    let now = Utc::now().timestamp();
    // 乐观并发：磁盘版本比前端基准新 → 拒绝覆盖（仅当磁盘文件可读时检查；新表/文件缺失跳过）
    if let Some(base) = base_updated_at {
        if let Ok(disk) = read_table_file(&old_path) {
            if disk.updated_at > base {
                return Err("表格已被外部修改，请重载后再编辑".to_string());
            }
        }
    }
    table.created_at = if old_path.exists() {
        read_table_file(&old_path)
            .map(|t| t.created_at)
            .map_err(|e| format!("磁盘表格文件损坏，无法保存：{} ({e})", old_path.display()))?
    } else {
        now
    };
    table.updated_at = now;
    write_table_file(&new_path, &table)?;
    // title 变更导致路径漂移：table 节点按 file 路径引用，须同步全部 .atlx（防断链）
    if old_path != new_path {
        let same_file = same_physical_file(&old_path, &new_path);
        let new_rel = table_file_rel(&file, &table.title);
        let pending = collect_table_ref_updates(&root, &file, &new_rel)?;
        if let Err(e) = flush_canvas_updates(&pending) {
            // 回滚：删新文件（旧文件未动、引用未刷，保持原名），防改名后引用断裂
            let _ = std::fs::remove_file(&new_path);
            return Err(format!("更新画布引用失败：{e}"));
        }
        // case-only 重命名（Windows 大小写不敏感文件系统）指向同一物理文件：不删旧文件（删即丢数据）
        if old_path.exists() && !same_file {
            std::fs::remove_file(&old_path).map_err(|e| format!("删除旧表格文件失败：{e}"))?;
        }
    }
    Ok(now)
}

/// 重命名表格：更新 .atb 内 title + 同目录重命名文件 + 扫描所有 .atlx 更新 table 节点引用。
/// 事务模式同 rename_note：预扫描 → 改名 → 统一写回，写回失败回滚文件。
#[tauri::command]
pub fn rename_table_vault(
    file: String,
    new_title: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let old_path = safe_join(&root, &file, false)?;
    let parent = old_path
        .parent()
        .ok_or_else(|| format!("非法路径：{}", file))?;
    let new_path = parent.join(format!("{}.atb", sanitize_filename(&new_title)));
    let new_rel = table_file_rel(&file, &new_title);
    let old_table = read_table_file(&old_path)?;
    let same_file = same_physical_file(&old_path, &new_path);
    // 目标已存在且非同文件：读现存 id 比对，异表拒绝覆盖（同 write_table_vault，防同步盘合并/
    // 隐藏/排除目录绕过前端 dedupe 时静默覆盖另一表格）
    if new_path.exists() && !same_file {
        if let Ok(existing) = read_table_file(&new_path) {
            if existing.id != old_table.id {
                return Err(format!("表格名冲突：另一表格已使用名称「{}」", new_title));
            }
        }
    }
    let pending = collect_table_ref_updates(&root, &file, &new_rel)?;
    let mut table = old_table.clone();
    table.title = new_title;
    table.updated_at = Utc::now().timestamp();
    // 先写新文件再删旧文件，保证不丢数据
    write_table_file(&new_path, &table)?;
    // case-only 重命名（Windows 大小写不敏感文件系统）指向同一物理文件：不删旧文件（删即丢数据）
    if old_path != new_path && !same_file {
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧表格文件失败：{e}"))?;
    }
    if let Err(e) = flush_canvas_updates(&pending) {
        // 尽力回滚：恢复旧文件（旧标题），清理新文件
        let _ = write_table_file(&old_path, &old_table);
        if old_path != new_path {
            let _ = std::fs::remove_file(&new_path);
        }
        return Err(format!("更新画布引用失败，重命名已回滚（请重试）：{e}"));
    }
    Ok(())
}

/// 移动表格文件到新路径（跨目录，拖动文件到文件夹用）+ 扫描所有 .atlx 更新 table 节点引用
/// （与 rename_table_vault 对称；rename_note_file 复用通用移动：路径校验 + 防覆盖）。
#[tauri::command]
pub fn move_table_vault(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let pending = collect_table_ref_updates(&root, &old_file, &new_file)?;
    rename_note_file(&root, &old_file, &new_file)?;
    if let Err(e) = flush_canvas_updates(&pending) {
        let _ = rename_note_file(&root, &new_file, &old_file);
        return Err(format!("更新画布引用失败，移动已回滚（请重试）：{e}"));
    }
    Ok(())
}

/// 删除表格 .atb 文件（不更新 .atlx 引用，画布 table 节点断链降级「文件缺失」）。
#[tauri::command]
pub fn delete_table_vault(file: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    delete_vault_file(&root, &file)
}

/// 读系统文件选择器选中的图片为 dataURL（多图单元格导入用；任意绝对路径，仅图片扩展名）。
/// 路径来自 OS 对话框（用户显式选择），非仓库内路径不走 safe_join（防穿越只约束仓库内输入）。
#[tauri::command]
pub fn read_external_image_data_url(src: String) -> Result<String, String> {
    let path = std::path::Path::new(&src);
    if !path.is_file() {
        return Err(format!("文件不存在：{}", src));
    }
    let mime = mime_from_ext(&src).ok_or_else(|| format!("非图片文件：{}", src))?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 导出表格为 .xlsx（目标路径来自系统保存对话框，任意位置可写）。
/// 列 = 字段顺序，表头 = 字段名（金色底 + 粗体 + 全表边框 + 冻结首行）；
/// image 字段嵌入单元格首图（等比缩至 140x90），text 换行，number/duration 数值，其余文本。
#[tauri::command]
pub fn export_table_xlsx(table: TableFile, target_path: String) -> Result<(), String> {
    use rust_xlsxwriter::{Format, FormatBorder, Image, Workbook};

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .set_name(sheet_name_of(&table.title))
        .map_err(|e| format!("设置工作表名失败：{e}"))?;

    let header_fmt = Format::new()
        .set_bold()
        .set_background_color("D4AF37")
        .set_border(FormatBorder::Thin);
    let wrap_fmt = Format::new().set_border(FormatBorder::Thin).set_text_wrap();
    let plain_fmt = Format::new().set_border(FormatBorder::Thin);

    for (c, field) in table.fields.iter().enumerate() {
        let col = c as u16;
        let _ = sheet.write_string_with_format(0, col, &field.name, &header_fmt);
        let _ = sheet.set_column_width(col, column_width_of(&field.field_type));
    }
    if !table.fields.is_empty() {
        let _ = sheet.set_freeze_panes(1, 0);
    }

    for (r, row) in table.rows.iter().enumerate() {
        let excel_row = (r + 1) as u32;
        let mut has_image = false;
        for (c, field) in table.fields.iter().enumerate() {
            let col = c as u16;
            let Some(value) = row.values.get(&field.id) else { continue };
            match field.field_type.as_str() {
                // 多图单元格 v1 只导首图；dataURL 剥前缀 → 等比缩至 140x90 嵌入（行高撑开）
                "image" => {
                    if let Some(url) = value.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
                        if let Some(bytes) = data_url_to_bytes(url) {
                            if let Ok(mut img) = Image::new_from_buffer(&bytes) {
                                img = img.set_scale_to_size(140, 90, true);
                                if sheet.insert_image(excel_row, col, &img).is_ok() {
                                    has_image = true;
                                }
                            }
                        }
                    }
                }
                "text" => {
                    if let Some(s) = value.as_str() {
                        let _ = sheet.write_string_with_format(excel_row, col, s, &wrap_fmt);
                    }
                }
                "number" | "duration" => {
                    if let Some(n) = value.as_f64() {
                        let _ = sheet.write_number_with_format(excel_row, col, n, &plain_fmt);
                    }
                }
                _ => {
                    if let Some(s) = value.as_str() {
                        let _ = sheet.write_string_with_format(excel_row, col, s, &plain_fmt);
                    }
                }
            }
        }
        if has_image {
            let _ = sheet.set_row_height(excel_row, 90);
        }
    }

    workbook
        .save(&target_path)
        .map_err(|e| format!("导出失败：{e}"))
}

/// 工作表名净化：禁止 `[]:*?/\` 字符 + 长度 ≤ 31（Excel 限制，超长/非法名会拒绝）。
fn sheet_name_of(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    let mut name = if trimmed.is_empty() { "表格".to_string() } else { trimmed.to_string() };
    name.truncate(31);
    name
}

/// 列宽按字段类型预设（Excel 字符宽度单位）。
fn column_width_of(field_type: &str) -> f64 {
    match field_type {
        "text" => 40.0,
        "number" => 12.0,
        "duration" => 10.0,
        "singleSelect" => 14.0,
        "image" => 20.0,
        _ => 20.0,
    }
}

/// dataURL（`data:<mime>;base64,...`）→ 字节；非 dataURL/解码失败返回 None。
fn data_url_to_bytes(url: &str) -> Option<Vec<u8>> {
    let b64 = url.split_once(",")?.1;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 由旧相对路径 + 新标题算新相对路径（同目录改文件名；净化规则与落盘一致）。
fn table_file_rel(old_file: &str, new_title: &str) -> String {
    let filename = format!("{}.atb", sanitize_filename(new_title));
    match old_file.rfind('/') {
        Some(i) => format!("{}/{}", &old_file[..i], filename),
        None => filename,
    }
}

/// 两路径是否指向同一物理文件（case-only 重命名在大小写不敏感文件系统上的场景）。
/// 都 canonicalize 成功且相等才豁免；任一失败（身份不明）不豁免（宁可拒绝覆盖，不可删错文件）。
fn same_physical_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}
