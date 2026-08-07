//! 仓库文件读写命令。
//!
//! 通过 `State<VaultState>` 注入当前仓库根路径。本模块为画布/笔记/附件/配置的唯一文件 I/O 出口。
//!
//! 本模块只做文件 I/O，不耦合业务语义：
//! - text 节点 bodyMd 的剥离/填充在 `services/vault` 层组合；
//! - 因此 `read_canvas_vault`/`write_canvas_vault` 直接读写 .atlx 文件，不操作 笔记/*.md。
//!
//! .atlx 文件命名约定：`<sanitized-title>.atlx`（标题即文件名，无 id 后缀，任意文件夹）
//! - 同名自动加序号（-2、-3）保证唯一性（`sanitize_filename` + 递增循环，见 `vault.rs`）；
//! - rename_canvas 时同时重命名文件；重命名/删除后所有引用它的画布内引用同步更新。

use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::Utc;
use nanoid::nanoid;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::vault::{
    create_folder as create_folder_impl, delete_vault_file,
    import_attachment as import_attachment_vault_impl, init_vault_dirs, list_canvas_files,
    list_vault_tree as list_vault_tree_impl, read_canvas_file, read_file_bytes,
    read_note as read_note_file, read_vault_config as read_vault_config_file, rename_note_file,
    safe_join, sanitize_filename, write_canvas_file, write_note as write_note_file,
    write_vault_config as write_vault_config_file, read_editor_chats_file,
    read_prompt_notes_file, write_prompt_notes_file, write_editor_chats_file,
    read_chat_messages_file, write_chat_messages_file, delete_chat_messages_file, CanvasFile,
    CanvasFileRow, EditorChatsFile, FileTreeNode, VaultConfig, VaultState, CANVAS_SCHEMA,
    read_ui_state_file, write_ui_state_file, VaultUiState,
};
use crate::watcher;

/// `open_vault` 返回的仓库信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// 仓库根绝对路径
    pub root: String,
    /// 仓库名（文件夹名）
    pub name: String,
    /// 仓库稳定 ID（`.atelyx/config.json` 的 vaultId，首次打开生成、之后固定）。
    pub id: String,
}

/// 打开仓库：设当前仓库根 + 初始化目录结构 + 启动文件监听 + 返回仓库信息。
/// root 经 dunce::canonicalize 存储（去 Windows `\\?\` 前缀，统一路径格式，与 watcher/路径校验语义一致）。
/// `vaultId`（`.atelyx/config.json`）首次打开生成、之后固定，前端据此识别仓库归属（防跨仓库搞混）。
#[tauri::command]
pub fn open_vault(
    path: String,
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<VaultInfo, String> {
    let raw = PathBuf::from(&path);
    if !raw.is_dir() {
        return Err(format!("仓库路径不是文件夹：{}", path));
    }
    let root = dunce::canonicalize(&raw).map_err(|e| format!("仓库路径不可达：{} ({e})", path))?;
    // 读仓库级配置拿生效的文件面板配置（排除文件夹 / 附件导入文件夹）+ 仓库稳定 ID，缺省 = 空
    let mut config = read_vault_config_file(&root)?;
    let (vault_id, vault_id_new) = ensure_vault_id(&mut config);
    let exclude_folders = config.exclude_folders.clone().unwrap_or_default();
    let attachment_folder = config.attachment_folder.clone();
    init_vault_dirs(&root)?;
    // 仅首次生成 vault_id 时落盘（失败不阻塞打开——下次打开会补写，内存值本轮回调已生效）
    if vault_id_new {
        let _ = write_vault_config_file(&root, &config);
    }
    // 先启监听再切 state：watcher 失败降级为警告（仓库仍可打开，实时同步降级为手动刷新）——
    // 大仓库递归监听可能超 OS watch 上限（Linux inotify max_user_watches），不阻塞打开
    if let Err(e) = watcher::start(app, root.clone(), exclude_folders.clone()) {
        eprintln!("文件监听启动失败（仓库仍可打开，实时同步降级）：{e}");
    }
    state.set(root.clone(), exclude_folders, attachment_folder)?;
    Ok(vault_info_from(root, vault_id))
}

/// 枚举当前仓库的画布列表（递归扫描全仓库 .atlx，按 updatedAt 倒序）。
#[tauri::command]
pub fn list_canvases_vault(state: State<'_, VaultState>) -> Result<Vec<CanvasFileRow>, String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    list_canvas_files(&root, &exclude)
}

/// 读 .atlx 文件（按相对仓库根路径，如 `项目A/方案.atlx`）。
#[tauri::command]
pub fn read_canvas_vault(file: String, state: State<'_, VaultState>) -> Result<CanvasFile, String> {
    let root = state.root()?;
    let path = safe_join(&root, &file, false)?;
    read_canvas_file(&path)
}

/// 写 .atlx 文件（整体原子写；title 改了会自动重命名文件到同目录新名）。
/// 自动更新 updated_at；保留原 created_at（从磁盘读，新画布用 now）。
/// `file`：画布相对仓库根路径（前端持有，画布任意文件夹存放）。
/// `base_updated_at`：前端基于的磁盘版本（加载时的 updatedAt）。磁盘版本更新则拒绝写
/// （乐观并发，防多用户/外部同步静默覆盖丢更新）；None = 不检查。
#[tauri::command]
pub fn write_canvas_vault(
    mut canvas: CanvasFile,
    file: String,
    base_updated_at: Option<i64>,
    state: State<'_, VaultState>,
) -> Result<i64, String> {
    let root = state.root()?;
    let old_path = safe_join(&root, &file, false)?;
    // 目标路径 = 同目录 + <sanitized-title>.atlx（title 变更 = 同目录改文件名，路径不漂移）
    let parent = old_path
        .parent()
        .ok_or_else(|| format!("非法路径：{}", file))?;
    let new_path = parent.join(format!("{}.atlx", sanitize_filename(&canvas.title)));
    // 新路径已存在且 id 不同（前端 dedupe 被绕过/同步盘合并）：拒绝覆盖，防静默丢失另一画布
    if new_path.exists() {
        if let Ok(existing) = read_canvas_file(&new_path) {
            if existing.id != canvas.id {
                return Err(format!("画布名冲突：另一画布已使用名称「{}」", canvas.title));
            }
        }
    }
    let now = Utc::now().timestamp();
    // 乐观并发：磁盘版本比前端基准新 → 拒绝覆盖（仅当磁盘文件可读时检查；新画布/文件缺失跳过）
    if let Some(base) = base_updated_at {
        if let Ok(disk) = read_canvas_file(&old_path) {
            if disk.updated_at > base {
                return Err("画布已被外部修改，请重载后再编辑".to_string());
            }
        }
    }
    // 保留原 createdAt：读旧文件，新画布用 now；旧文件损坏 → 拒绝覆盖（防损坏文件被整体覆盖丢数据）
    canvas.created_at = if old_path.exists() {
        read_canvas_file(&old_path)
            .map(|c| c.created_at)
            .map_err(|e| format!("磁盘画布文件损坏，无法保存：{} ({e})", old_path.display()))?
    } else {
        now
    };
    canvas.updated_at = now;
    write_canvas_file(&new_path, &canvas)?;
    if old_path != new_path && old_path.exists() {
        // 旧文件已不在需要，删除；失败须报错，否则同 id 双文件会歧义（列表读到旧内容）
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧画布文件失败：{e}"))?;
    }
    // 返回写入的 updated_at，前端保存成功后同步乐观锁基准（防下次保存误判冲突）
    Ok(now)
}

/// 重命名画布：更新 .atlx 内 title + 同目录重命名文件（按当前文件路径）。
#[tauri::command]
pub fn rename_canvas_vault(
    file: String,
    new_title: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let old_path = safe_join(&root, &file, false)?;
    let mut canvas = read_canvas_file(&old_path)?;
    canvas.title = new_title;
    canvas.updated_at = Utc::now().timestamp();
    let parent = old_path
        .parent()
        .ok_or_else(|| format!("非法路径：{}", file))?;
    let new_path = parent.join(format!("{}.atlx", sanitize_filename(&canvas.title)));
    // 先写新文件再删旧文件，保证不丢数据
    write_canvas_file(&new_path, &canvas)?;
    if old_path != new_path {
        // 删除失败须报错（同 id 双文件歧义），但新文件已落盘，下次保存会重试清理
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧画布文件失败：{e}"))?;
    }
    Ok(())
}

/// 移动画布文件到新路径（跨目录，拖动文件到文件夹用）。画布不被其他文件引用，
/// 无需更新任何 .atlx；前端负责同步 canvases 列表 / currentCanvasFile 路径。
#[tauri::command]
pub fn move_canvas_vault(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    rename_note_file(&root, &old_file, &new_file)
}

/// 删除画布 .atlx 文件（不删 笔记/附件，文件可跨画布共享）。
#[tauri::command]
pub fn delete_canvas_vault(file: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    let path = safe_join(&root, &file, false)?;
    if !path.exists() {
        return Err(format!("文件不存在：{}", file));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// 读 .md 笔记（按相对仓库根路径，如 `笔记/xxx.md`）。
#[tauri::command]
pub fn read_note(file: String, state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    read_note_file(&root, &file)
}

/// 读外部白板文件（`.canvas` JSON 原文，只读查看/转换为画布用）。
/// 复用通用文本读（safe_join 校验）；不提供写命令——白板格式保持只读，不被本应用改写。
#[tauri::command]
pub fn read_whiteboard_canvas(
    file: String,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = state.root()?;
    read_note_file(&root, &file)
}

/// 写 .md 笔记（原子写，自动建父目录）。
#[tauri::command]
pub fn write_note(
    file: String,
    content: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_note_file(&root, &file, &content)
}

/// 重命名 .md 笔记 + 扫描所有 .atlx 更新 text 节点 file 引用（链接维护）。
/// 预扫描 → 改名 → 统一写回：任一 .atlx 写回失败时回滚重命名（避免「已改名但引用未更新、
/// 重试报源文件不存在」的半完成态）。
#[tauri::command]
pub fn rename_note(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let pending = collect_note_ref_updates(&root, &old_file, &new_file)?;
    rename_note_file(&root, &old_file, &new_file)?;
    if let Err(e) = flush_canvas_updates(&pending) {
        // 尽力回滚：恢复源文件原名（部分画布引用可能已写回，错误信息如实说明）
        let _ = rename_note_file(&root, &new_file, &old_file);
        return Err(format!("更新画布引用失败，重命名已回滚（请重试）：{e}"));
    }
    Ok(())
}

/// 枚举仓库文件树（文件面板全仓库树；跳过隐藏/排除目录与 `.tmp`）。
#[tauri::command]
pub fn list_vault_tree(state: State<'_, VaultState>) -> Result<Vec<FileTreeNode>, String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    list_vault_tree_impl(&root, &exclude)
}

/// 新建文件夹（相对仓库根路径，如 `项目A/素材`），自动建父目录；返回相对路径。
#[tauri::command]
pub fn create_folder(dir: String, state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    create_folder_impl(&root, &dir)
}

/// 删除 .md 笔记（不更新 .atlx 引用，断链降级由前端 TextNode 显示「文件缺失」提示）。
#[tauri::command]
pub fn delete_note(file: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    delete_vault_file(&root, &file)
}

/// 删除附件（同 delete_note，不更新 .atlx 引用）。
#[tauri::command]
pub fn delete_attachment(file: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    delete_vault_file(&root, &file)
}

/// 重命名附件 + 扫描所有 .atlx 更新 media 节点 file 引用（链接维护，与 rename_note 对称）。
#[tauri::command]
pub fn rename_attachment(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let pending = collect_attachment_ref_updates(&root, &old_file, &new_file)?;
    rename_note_file(&root, &old_file, &new_file)?;
    if let Err(e) = flush_canvas_updates(&pending) {
        let _ = rename_note_file(&root, &new_file, &old_file);
        return Err(format!("更新画布引用失败，重命名已回滚（请重试）：{e}"));
    }
    Ok(())
}

/// 读附件为 dataURL（`data:<mime>;base64,...`），供前端 MediaNode 显示图片。
/// 仅图片扩展名（png/jpg/jpeg/webp/gif）支持；其他返回错误（前端走文本解析分支）。
/// 读仓库内附件为 data URL（media 节点缩略图/预览用）。mime 按扩展名推断，失败降级 application/octet-stream。
#[tauri::command]
pub fn read_attachment_data_url(
    file: String,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = state.root()?;
    let bytes = read_file_bytes(&root, &file)?;
    let mime = mime_from_ext(&file).ok_or_else(|| format!("非图片附件，不支持 dataURL：{}", file))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 把系统文件（对话框选择）导入仓库（默认根目录，设置可配附件文件夹），返回相对路径（导入后建媒体节点用）。
#[tauri::command]
pub fn import_attachment_vault(
    src: String,
    name: String,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let root = state.root()?;
    let folder = state.attachment_folder()?.unwrap_or_default();
    import_attachment_vault_impl(&root, &folder, Path::new(&src), &name)
}

/// 按扩展名推图片 mime（仅图片，其他返回 None）。
fn mime_from_ext(file: &str) -> Option<&'static str> {
    let ext = Path::new(file)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// 读仓库级配置（.atelyx/config.json，不存在返回空覆盖）。
#[tauri::command]
pub fn read_vault_config(state: State<'_, VaultState>) -> Result<VaultConfig, String> {
    let root = state.root()?;
    read_vault_config_file(&root)
}

/// 写仓库级配置（原子写 .atelyx/config.json；类型层不含 api_key，防 key 落仓库）。
#[tauri::command]
pub fn write_vault_config(
    config: VaultConfig,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_vault_config_file(&root, &config)
}

/// 读系统提示词标记列表（.atelyx/prompt-notes.json，不存在/损坏返回空）。
#[tauri::command]
pub fn read_prompt_notes(state: State<'_, VaultState>) -> Result<Vec<String>, String> {
    let root = state.root()?;
    read_prompt_notes_file(&root)
}

/// 写系统提示词标记列表（原子写 .atelyx/prompt-notes.json，独立于 config.json）。
#[tauri::command]
pub fn write_prompt_notes(
    files: Vec<String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_prompt_notes_file(&root, &files)
}

/// 读 AI 对话面板会话（.atelyx/editor-chats.json，不存在/损坏返回默认）。
#[tauri::command]
pub fn read_editor_chats(state: State<'_, VaultState>) -> Result<EditorChatsFile, String> {
    let root = state.root()?;
    read_editor_chats_file(&root)
}

/// 写 AI 对话面板会话（原子写 .atelyx/editor-chats.json；类型层不含 api_key）。
#[tauri::command]
pub fn write_editor_chats(
    file: EditorChatsFile,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_editor_chats_file(&root, &file)
}

/// 读会话消息正文 .md（.atelyx/对话历史/ 下，路径已校验；文件缺失报错由前端 catch 降级）。
#[tauri::command]
pub fn read_chat_messages(state: State<'_, VaultState>, file: String) -> Result<String, String> {
    let root = state.root()?;
    read_chat_messages_file(&root, &file)
}

/// 写会话消息正文 .md（自动建目录 + 原子写；路径已校验）。
#[tauri::command]
pub fn write_chat_messages(
    state: State<'_, VaultState>,
    file: String,
    content: String,
) -> Result<(), String> {
    let root = state.root()?;
    write_chat_messages_file(&root, &file, &content)
}

/// 删会话消息正文 .md（不存在视为成功——幂等）。
#[tauri::command]
pub fn delete_chat_messages(state: State<'_, VaultState>, file: String) -> Result<(), String> {
    let root = state.root()?;
    delete_chat_messages_file(&root, &file)
}

/// 读仓库级 UI 使用状态（.atelyx/ui-state.json，不存在/损坏返回默认：展开空、无上次打开文件）。
#[tauri::command]
pub fn read_ui_state(state: State<'_, VaultState>) -> Result<VaultUiState, String> {
    let root = state.root()?;
    read_ui_state_file(&root)
}

/// 写仓库级 UI 使用状态（原子写 .atelyx/ui-state.json）。
#[tauri::command]
pub fn write_ui_state(state: VaultUiState, vault: State<'_, VaultState>) -> Result<(), String> {
    let root = vault.root()?;
    write_ui_state_file(&root, &state)
}

/// 确保默认仓库已打开（首启 bootstrap：无最近仓库时建默认仓库并打开）。
///
/// 流程：已打开则返回 → 否则建 `app_data_dir/default-vault` → 初始化目录 →
/// 设为当前仓库 + 启动文件监听。
#[tauri::command]
pub fn ensure_default_vault(
    app_handle: AppHandle,
    state: State<'_, VaultState>,
) -> Result<VaultInfo, String> {
    // 已打开则直接返回（重新读配置拿 id；缺失时补生成，与 open_vault 语义一致）
    if let Ok(root) = state.root() {
        let mut config = read_vault_config_file(&root)?;
        let (vault_id, vault_id_new) = ensure_vault_id(&mut config);
        if vault_id_new {
            let _ = write_vault_config_file(&root, &config);
        }
        return Ok(vault_info_from(root, vault_id));
    }
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let default_root = app_data_dir.join("default-vault");
    if !default_root.exists() {
        std::fs::create_dir_all(&default_root).map_err(|e| e.to_string())?;
    }
    // 读配置拿生效的文件面板配置（排除文件夹/附件导入文件夹）+ 仓库稳定 ID，与 open_vault 同流程
    let mut config = read_vault_config_file(&default_root)?;
    let (vault_id, vault_id_new) = ensure_vault_id(&mut config);
    let exclude_folders = config.exclude_folders.clone().unwrap_or_default();
    let attachment_folder = config.attachment_folder.clone();
    init_vault_dirs(&default_root)?;
    if vault_id_new {
        let _ = write_vault_config_file(&default_root, &config);
    }
    // 与 open_vault 一致：dunce::canonicalize → 先启监听再切 state，保证存/回传格式统一
    let default_root = dunce::canonicalize(&default_root)
        .map_err(|e| format!("默认仓库路径不可达：{} ({e})", default_root.display()))?;
    // watcher 失败降级（同 open_vault）：不阻塞默认仓库打开
    if let Err(e) = watcher::start(app_handle, default_root.clone(), exclude_folders.clone()) {
        eprintln!("文件监听启动失败（仓库仍可打开，实时同步降级）：{e}");
    }
    state.set(default_root.clone(), exclude_folders, attachment_folder)?;
    Ok(vault_info_from(default_root, vault_id))
}

/// 新建空画布，返回 `{ id, file }`（file = 相对仓库根路径，前端打开/保存用）。
#[tauri::command]
pub fn create_canvas_vault(
    title: String,
    dir: String,
    state: State<'_, VaultState>,
) -> Result<CanvasCreateResult, String> {
    let root = state.root()?;
    let id = nanoid!();
    let now = Utc::now().timestamp();
    let canvas = CanvasFile {
        schema: CANVAS_SCHEMA.to_string(),
        id: id.clone(),
        title: title.clone(),
        viewport: serde_json::json!({"x": 0, "y": 0, "zoom": 1}),
        nodes: vec![],
        edges: vec![],
        created_at: now,
        updated_at: now,
    };
    // 目标路径：dir（相对仓库根，空 = 根目录）+ <sanitized-title>.atlx
    let filename = format!("{}.atlx", sanitize_filename(&title));
    let rel = if dir.is_empty() {
        filename
    } else {
        format!("{dir}/{filename}")
    };
    let path = safe_join(&root, &rel, true)?;
    // 后端兜底：同名画布已存在则拒绝（前端 dedupe 是正常路径，此处防绕过/同步盘合并覆盖）
    if path.exists() {
        return Err(format!("画布名冲突：{}", title));
    }
    write_canvas_file(&path, &canvas)?;
    Ok(CanvasCreateResult { id, file: rel })
}

/// `create_canvas_vault` 返回值：id（运行时身份）+ file（磁盘定位）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCreateResult {
    pub id: String,
    pub file: String,
}

// ===== 内部辅助 =====

/// 仓库稳定 ID：读配置的 vaultId（存量仓库缺失则生成 nanoid），保证同一仓库 ID 恒定、仓库间互不混淆。
/// 返回 `(id, 是否新建)`——仅新建时才需写盘，避免每次打开重写 config.json 的 IO 噪声。
fn ensure_vault_id(config: &mut VaultConfig) -> (String, bool) {
    if let Some(id) = &config.vault_id {
        if !id.trim().is_empty() {
            return (id.clone(), false);
        }
    }
    let id = nanoid!();
    config.vault_id = Some(id.clone());
    (id, true)
}

/// 从路径构造 VaultInfo（仓库名经 `vault_display_name`，兼容网络共享根等 `file_name()` 取不到的场景）。
fn vault_info_from(root: PathBuf, id: String) -> VaultInfo {
    VaultInfo {
        root: root.to_string_lossy().to_string(),
        name: crate::vault::vault_display_name(&root),
        id,
    }
}

/// 递归扫描仓库内全部 .atlx，命中更新条件的收集（不写盘，flush_canvas_updates 统一写回）。
/// 全仓库扫描：被引用文件与画布可能位于任意文件夹（含排除/隐藏目录），链接维护不过滤。
fn collect_canvas_updates(
    root: &Path,
    update: &mut dyn FnMut(&mut CanvasFile) -> bool,
) -> Result<Vec<(PathBuf, CanvasFile)>, String> {
    let mut updates: Vec<(PathBuf, CanvasFile)> = vec![];
    scan_atlx_in(root, "", update, &mut updates)?;
    Ok(updates)
}

fn scan_atlx_in(
    root: &Path,
    rel: &str,
    update: &mut dyn FnMut(&mut CanvasFile) -> bool,
    updates: &mut Vec<(PathBuf, CanvasFile)>,
) -> Result<(), String> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            scan_atlx_in(root, &child_rel, update, updates)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("atlx") {
            let mut canvas = match read_canvas_file(&path) {
                Ok(c) => c,
                Err(_) => continue, // 跳过无法解析的文件，不阻塞其他画布的链接维护
            };
            if update(&mut canvas) {
                canvas.updated_at = Utc::now().timestamp();
                updates.push((path, canvas));
            }
        }
    }
    Ok(())
}

/// 收集需更新 text `file` / conversation `systemPromptFile` 引用的画布（不写盘）。
fn collect_note_ref_updates(
    root: &Path,
    old_file: &str,
    new_file: &str,
) -> Result<Vec<(PathBuf, CanvasFile)>, String> {
    collect_canvas_updates(root, &mut |canvas| {
        update_note_refs_in_canvas(canvas, old_file, new_file)
    })
}

/// 收集需更新 media 节点 file 引用的画布（不写盘）。与 collect_note_ref_updates 对称。
fn collect_attachment_ref_updates(
    root: &Path,
    old_file: &str,
    new_file: &str,
) -> Result<Vec<(PathBuf, CanvasFile)>, String> {
    collect_canvas_updates(root, &mut |canvas| {
        update_attachment_refs_in_canvas(canvas, old_file, new_file)
    })
}

/// 更新单个 .atlx 内的 `.md` 引用（内存中）：text 节点的 `file` + conversation 节点的 `systemPromptFile`。
/// 返回是否有变更。
fn update_note_refs_in_canvas(
    canvas: &mut CanvasFile,
    old_file: &str,
    new_file: &str,
) -> bool {
    let mut changed = false;
    for node in &mut canvas.nodes {
        let Some(obj) = node.data.as_object_mut() else {
            continue;
        };
        let ref_field = match node.node_type.as_str() {
            // text 节点正文引用（笔记/*.md）
            "text" => Some("file"),
            // conversation 节点系统提示词引用（笔记/*.md，与 text 对称）
            "conversation" => Some("systemPromptFile"),
            _ => None,
        };
        if let Some(field) = ref_field {
            if obj.get(field).and_then(|v| v.as_str()) == Some(old_file) {
                obj.insert(field.to_string(), serde_json::Value::String(new_file.to_string()));
                changed = true;
            }
        }
    }
    changed
}

/// 统一写回收集的画布更新（rename 成功后才调用；失败由调用方回滚 rename）。
fn flush_canvas_updates(updates: &[(PathBuf, CanvasFile)]) -> Result<(), String> {
    for (path, canvas) in updates {
        write_canvas_file(path, canvas)?;
    }
    Ok(())
}

/// 更新单个 .atlx 内 media 节点的 file 引用（内存中），返回是否有变更。
fn update_attachment_refs_in_canvas(
    canvas: &mut CanvasFile,
    old_file: &str,
    new_file: &str,
) -> bool {
    let mut changed = false;
    for node in &mut canvas.nodes {
        if node.node_type != "media" {
            continue;
        }
        if let Some(obj) = node.data.as_object_mut() {
            if obj.get("file").and_then(|v| v.as_str()) == Some(old_file) {
                obj.insert(
                    "file".to_string(),
                    serde_json::Value::String(new_file.to_string()),
                );
                changed = true;
            }
        }
    }
    changed
}
