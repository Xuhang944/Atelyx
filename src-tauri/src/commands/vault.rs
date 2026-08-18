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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::Utc;
use nanoid::nanoid;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::vault::{
    append_chat_messages_file, cache_put_canvas, collect_md_link_updates,
    copy_folder as copy_folder_impl, create_folder as create_folder_impl,
    delete_folder as delete_folder_impl, delete_vault_file, flush_md_updates,
    import_attachment as import_attachment_vault_impl, init_vault_dirs, list_canvas_files,
    list_vault_tree as list_vault_tree_impl, markdown_link_path, read_canvas_file,
    read_canvas_file_cached, read_file_bytes, read_note as read_note_file,
    read_vault_config as read_vault_config_file, refresh_wiki_index,
    rename_folder as rename_folder_impl, rename_note_file, rel_with_new_title,
    resolve_link_target, rewrite_internal_links, safe_join, same_physical_file,
    sanitize_filename, walk_md_in, write_canvas_file, write_note as write_note_file, write_vault_config as write_vault_config_file,
    read_editor_chats_file, read_prompt_notes_file, write_prompt_notes_file,
    read_folder_colors_file, write_folder_colors_file,
    write_editor_chats_file, read_chat_messages_file, write_chat_messages_file,
    delete_chat_messages_file, read_dir_filtered, regenerate_file_id, cache_evict_canvas,
    BacklinkRow, CanvasFile, CanvasFileRow, CanvasPatch,
    ChatSegment, DeleteFolderResult, EditorChatsFile, FileTreeNode, VaultConfig, VaultState,
    WikiIndex, CANVAS_SCHEMA, query_wiki_backlinks,
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
    // （warm_app/warm_exclude 在移动前克隆：反链索引后台预热用）
    let warm_app = app.clone();
    let warm_exclude = exclude_folders.clone();
    if let Err(e) = watcher::start(app, root.clone(), exclude_folders.clone()) {
        eprintln!("文件监听启动失败（仓库仍可打开，实时同步降级）：{e}");
    }
    state.set(root.clone(), exclude_folders, attachment_folder)?;
    // 反链索引后台预热：把唯一一次全量扫描（读全部 .md 提取引用）塞进「进入仓库」阶段，不阻塞打开；
    // 失败静默——首次反链查询会懒构建兜底（预热与查询竞争时以先建为准，索引幂等可重建）。
    // 锁 poison 在此同样容忍：后台预热非关键路径，查询侧会重建。
    let warm_root = root.clone();
    std::thread::spawn(move || {
        if let Some(st) = warm_app.try_state::<VaultState>() {
            if let Ok(mut guard) = st.wiki.lock() {
                if guard.is_none() {
                    *guard = Some(WikiIndex::default());
                    let _ = refresh_wiki_index(&warm_root, &warm_exclude, guard.as_mut().unwrap());
                }
            }
        }
    });
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
/// 乐观锁检查与 createdAt 保留共走一次带缓存读（指纹校验失效，外部改动即时感知）。
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
    // 乐观并发 + createdAt 保留共读一次（缓存命中免重读；文件缺失 = 新画布用 now）
    if old_path.exists() {
        let (_, disk) = read_canvas_file_cached(&state, &root, &file)
            .map_err(|e| format!("磁盘画布文件损坏，无法保存：{} ({e})", old_path.display()))?;
        if let Some(base) = base_updated_at {
            if disk.updated_at > base {
                return Err("画布已被外部修改，请重载后再编辑".to_string());
            }
        }
        canvas.created_at = disk.created_at;
    } else {
        canvas.created_at = now;
    }
    canvas.updated_at = now;
    write_canvas_file(&new_path, &canvas)?;
    // case-only 重命名（Windows 大小写不敏感文件系统）指向同一物理文件：不删旧文件（删即丢数据）
    if old_path != new_path && old_path.exists() && !same_physical_file(&old_path, &new_path) {
        // 旧文件已不在需要，删除；失败须报错，否则同 id 双文件会歧义（列表读到旧内容）
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧画布文件失败：{e}"))?;
    }
    let new_rel = rel_with_new_title(&file, &canvas.title, "atlx");
    cache_evict_canvas(&state, &file);
    cache_put_canvas(&state, &new_path, &new_rel, &canvas);
    // 返回写入的 updated_at，前端保存成功后同步乐观锁基准（防下次保存误判冲突）
    Ok(now)
}

/// 增量保存 .atlx（自动保存主路径）：只写变化/新增/删除的实体（前端按引用 diff 计算补丁），
/// 按稳定 id 合并到磁盘全量文件——乐观锁 / createdAt 保留 / title 重命名 / 原子写语义
/// 与 write_canvas_vault 完全一致，IPC 载荷从整画布缩到变化实体。
/// 返回 (updatedAt, 写盘后的相对路径)——title 变更重命名文件时前端按新路径更新 canvasFile。
/// 冲突策略（与表格的 force「保留本地」不对称，属有意设计）：画布冲突一律报错，由前端提示
/// 「重载（丢本地）或合并（mergeFromDisk 三方合并）」——画布是拓扑+消息的复合体，
/// 无表格行级 LWW 的明确语义，不做静默覆盖。
#[tauri::command]
pub fn patch_canvas_vault(
    patch: CanvasPatch,
    file: String,
    base_updated_at: Option<i64>,
    state: State<'_, VaultState>,
) -> Result<(i64, String), String> {
    let root = state.root()?;
    let old_path = safe_join(&root, &file, false)?;
    // 磁盘文件缺失（外部删除）：补丁只有变化实体，重建会丢未变化部分——拒绝并回退全量写
    if !old_path.exists() {
        return Err("画布文件不存在（已从磁盘删除）".to_string());
    }
    let (_, mut canvas) = read_canvas_file_cached(&state, &root, &file)?;
    // 防串文件守卫：补丁属于另一画布（陈旧保存回调）→ 拒绝，防跨文件混写
    if patch.id != canvas.id {
        return Err("画布身份不匹配，已中止保存".to_string());
    }
    if let Some(title) = &patch.title {
        canvas.title = title.clone();
    }
    let parent = old_path
        .parent()
        .ok_or_else(|| format!("非法路径：{}", file))?;
    let new_path = parent.join(format!("{}.atlx", sanitize_filename(&canvas.title)));
    let new_rel = rel_with_new_title(&file, &canvas.title, "atlx");
    // 新路径已存在且 id 不同（前端 dedupe 被绕过/同步盘合并）：拒绝覆盖，防静默丢失另一画布。
    // 仅路径漂移（title 变更）时检查——同名时文件就是本次基底，id 必然一致，免每次保存全量重读
    if old_path != new_path && new_path.exists() {
        if let Ok(existing) = read_canvas_file(&new_path) {
            if existing.id != canvas.id {
                return Err(format!("画布名冲突：另一画布已使用名称「{}」", canvas.title));
            }
        }
    }
    let now = Utc::now().timestamp();
    // 乐观并发：磁盘版本比前端基准新 → 拒绝覆盖（缓存已按指纹保证磁盘最新）
    if let Some(base) = base_updated_at {
        if canvas.updated_at > base {
            return Err("画布已被外部修改，请重载后再编辑".to_string());
        }
    }
    // 按稳定 id 合并（removed 幂等；upsert 覆盖同 id 或追加）
    let removed_nodes: HashSet<&String> = patch.removed_node_ids.iter().collect();
    canvas.nodes.retain(|n| !removed_nodes.contains(&n.id));
    for n in &patch.upsert_nodes {
        match canvas.nodes.iter_mut().find(|x| x.id == n.id) {
            Some(existing) => *existing = n.clone(),
            None => canvas.nodes.push(n.clone()),
        }
    }
    let removed_edges: HashSet<&String> = patch.removed_edge_ids.iter().collect();
    canvas.edges.retain(|e| !removed_edges.contains(&e.id));
    for e in &patch.upsert_edges {
        match canvas.edges.iter_mut().find(|x| x.id == e.id) {
            Some(existing) => *existing = e.clone(),
            None => canvas.edges.push(e.clone()),
        }
    }
    canvas.updated_at = now;
    write_canvas_file(&new_path, &canvas)?;
    // case-only 重命名（Windows 大小写不敏感文件系统）指向同一物理文件：不删旧文件（删即丢数据）
    if old_path != new_path && old_path.exists() && !same_physical_file(&old_path, &new_path) {
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧画布文件失败：{e}"))?;
    }
    cache_evict_canvas(&state, &file);
    cache_put_canvas(&state, &new_path, &new_rel, &canvas);
    Ok((now, new_rel))
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
    // case-only 重命名（Windows 大小写不敏感文件系统）指向同一物理文件：不删旧文件（删即丢数据）
    if old_path != new_path && !same_physical_file(&old_path, &new_path) {
        // 删除失败须报错（同 id 双文件歧义），但新文件已落盘，下次保存会重试清理
        std::fs::remove_file(&old_path).map_err(|e| format!("删除旧画布文件失败：{e}"))?;
    }
    // 重命名路径变化：清旧缓存键 + 新路径按新指纹入缓存
    if new_path != old_path {
        cache_evict_canvas(&state, &file);
        let new_rel = rel_with_new_title(&file, &canvas.title, "atlx");
        cache_put_canvas(&state, &new_path, &new_rel, &canvas);
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
    rename_note_file(&root, &old_file, &new_file)?;
    // 移动路径变化：清旧路径缓存键（新路径下次读盘自然入缓存）
    cache_evict_canvas(&state, &old_file);
    Ok(())
}

/// 删除画布 .atlx 文件（不删 笔记/附件，文件可跨画布共享）。
#[tauri::command]
pub fn delete_canvas_vault(file: String, state: State<'_, VaultState>) -> Result<(), String> {
    let root = state.root()?;
    let path = safe_join(&root, &file, false)?;
    if !path.exists() {
        return Err(format!("文件不存在：{}", file));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    cache_evict_canvas(&state, &file);
    Ok(())
}

/// 读 .md 笔记（按相对仓库根路径，如 `笔记/xxx.md`）。
#[tauri::command]
pub fn read_note(file: String, state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    read_note_file(&root, &file)
}

/// 查询反链（`[[note_name]]` 或 `[label](基于仓库的路径)` 两种写法；索引缓存 + 指纹增量刷新）。
/// 只扫 .md 不扫 .atlx；与文件树同过滤（跳过隐藏/排除目录，`.atelyx/对话历史` 会话正文不算反链）。
/// 索引懒构建 + 后台预热（open_vault），切仓库随 set 清空——纯内存缓存，磁盘为真相（外部编辑自愈）。
#[tauri::command]
pub fn scan_wiki_backlinks(
    note_name: String,
    note_file: String,
    state: State<'_, VaultState>,
) -> Result<Vec<BacklinkRow>, String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    let mut guard = state.wiki.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(WikiIndex::default());
    }
    refresh_wiki_index(&root, &exclude, guard.as_mut().unwrap())?;
    Ok(query_wiki_backlinks(guard.as_ref().unwrap(), &note_name, &note_file))
}

/// 重建内部链接的结果统计。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildLinksResult {
    /// 扫描的 .md 文件数
    pub scanned: u32,
    /// 实际写回修改的文件数
    pub modified: u32,
    /// 改写的链接处数
    pub links: u32,
}

/// 一键重建内部链接（设置 → 编辑器）：全仓库 .md 统一规范为标准 Markdown 写法
/// `[名](基于仓库的规范路径)`；目标笔记不存在 → `[名]()`（点击可快捷新建）。
/// 只改写链接跨度（跳过 frontmatter/代码块/行内代码/图片链接/外部链接/非 .md 相对路径），
/// 其余内容字节级原样保留；只写有变化的文件（原子写）。单文件失败跳过不阻塞其余。
#[tauri::command]
pub fn rebuild_internal_links(
    state: State<'_, VaultState>,
) -> Result<RebuildLinksResult, String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    // 收集全部 .md 相对路径 + 构建解析表（精确路径 + 文件名索引；同名歧义 = 不解析）
    let mut files: Vec<String> = vec![];
    walk_md_in(&root, "", &exclude, &mut |rel, _path| {
        files.push(rel.to_string());
        Ok(())
    })?;
    let exact: std::collections::HashSet<String> = files.iter().cloned().collect();
    let mut by_basename: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for rel in &files {
        let base = rel.rsplit('/').next().unwrap_or(rel).to_string();
        by_basename.entry(base).or_default().push(rel.clone());
    }
    let resolve =
        |name: &str| resolve_link_target(name, &exact, &by_basename);
    let mut modified = 0u32;
    let mut links = 0u32;
    for rel in &files {
        let path = safe_join(&root, rel, false)?;
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // 不可读跳过
        };
        let (next, n) = rewrite_internal_links(&content, &resolve);
        if n > 0 {
            links += n as u32;
            if let Err(e) = write_note_file(&root, rel, &next) {
                eprintln!("重建内部链接写回失败（跳过该文件）：{rel}: {e}");
                continue;
            }
            modified += 1;
        }
    }
    Ok(RebuildLinksResult {
        scanned: files.len() as u32,
        modified,
        links,
    })
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

/// 读仓库内任意文本文件（安全边界 = 仓库根，safe_join 校验；非 UTF-8 返回替换字符容错）。
/// AI read_file 等通用文件工具的后端。
#[tauri::command]
pub fn read_vault_file(file: String, state: State<'_, VaultState>) -> Result<String, String> {
    let root = state.root()?;
    read_note_file(&root, &file)
}

/// 写仓库内任意文本文件（指定相对路径；原子写 + 自动建父目录）。
/// AI write_file/edit_file 等通用文件工具的后端。
#[tauri::command]
pub fn write_vault_file(
    file: String,
    content: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_note_file(&root, &file, &content)
}

/// 重命名 .md 笔记 + 扫描所有 .atlx 更新 text 节点 file 引用 + 扫描所有 .md 更新内部链接（链接维护）。
/// 预扫描 → 改名 → 统一写回：任一写回失败时回滚重命名（避免「已改名但引用未更新、
/// 重试报源文件不存在」的半完成态）。
/// .md 链接维护只认规范路径形态（`[x](旧路径)`）——编码等非规范形态由「重建内部链接」归一后纳入维护。
#[tauri::command]
pub fn rename_note(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    let pending = collect_note_ref_updates(&root, &old_file, &new_file)?;
    let pending_md = collect_md_link_updates(&root, &exclude, &mut |span: &str| {
        let Some(path) = markdown_link_path(span) else {
            return span.to_string();
        };
        if path != old_file {
            return span.to_string();
        }
        let label_end = span.find("](").unwrap_or(span.len() - 1);
        format!("{}]({new_file})", &span[..label_end])
    })?;
    // 收集发生在重命名前：被重命名笔记自身的旧路径自引用条目，写回目标必须是新路径（防旧路径重建文件）
    let pending_md: Vec<(String, String)> = pending_md
        .into_iter()
        .map(|(rel, content)| {
            if rel == old_file {
                (new_file.clone(), content)
            } else {
                (rel, content)
            }
        })
        .collect();
    rename_note_file(&root, &old_file, &new_file)?;
    if let Err(e) = flush_canvas_updates(&pending) {
        // 尽力回滚：恢复源文件原名（部分画布引用可能已写回，错误信息如实说明）
        let _ = rename_note_file(&root, &new_file, &old_file);
        return Err(format!("更新画布引用失败，重命名已回滚（请重试）：{e}"));
    }
    if let Err(e) = flush_md_updates(&root, &pending_md) {
        let _ = rename_note_file(&root, &new_file, &old_file);
        return Err(format!("更新笔记内部链接失败，重命名已回滚（请重试）：{e}"));
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

/// 复制仓库内文件为同目录副本（纯字节复制；新路径由前端 dedupe 防重名）。
/// `.atlx`/`.atb` 副本重新生成 id（与 copy_folder 的 regenerate_ids_in 同语义，
/// 防同 id 双文件歧义：画布标签按 id 去重、协作合并按 id 身份）；title 保持原样。
#[tauri::command]
pub fn copy_vault_file(
    old_file: String,
    new_file: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let src = safe_join(&root, &old_file, false)?;
    let dst = safe_join(&root, &new_file, true)?;
    if !src.is_file() {
        return Err(format!("源不是文件：{}", old_file));
    }
    // 目标已存在拒绝（防覆盖丢数据；前端 dedupe 已防重名，此处兜底并发/外部创建）
    if dst.exists() {
        return Err(format!("目标文件已存在：{}", new_file));
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("复制文件失败：{e}"))?;
    regenerate_file_id(&dst)?;
    Ok(())
}

/// 复制文件夹为同父目录副本（递归复制全部内容；新路径由前端 dedupe 防重名）。
#[tauri::command]
pub fn copy_vault_folder(
    old_dir: String,
    new_dir: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    copy_folder_impl(&root, &old_dir, &new_dir)
}

/// 删除文件夹（相对仓库根路径）。force=false 空目录直接删，非空返回 needsConfirm 供前端弹窗；
/// 确认后以 force=true 递归删除全部内容。仓库根（空路径）拒绝。
#[tauri::command]
pub fn delete_folder(
    dir: String,
    force: bool,
    state: State<'_, VaultState>,
) -> Result<DeleteFolderResult, String> {
    let root = state.root()?;
    delete_folder_impl(&root, &dir, force)
}

/// 重命名文件夹：移动整个目录 + 扫描所有 .atlx 更新位于该目录下文件的引用
/// （text `file` / media `file` / conversation `systemPromptFile` 按 `old_dir/` 前缀替换）
/// + 扫描所有 .md 更新内部链接（`](old_dir/` 前缀替换为 `](new_dir/`，链接维护）。
/// 事务模式与 rename_note 对称：先移动目录（旧路径已不存在），再扫描新树收集引用更新并统一写回；
/// 扫描或写回失败时回滚目录移动（部分画布引用可能已写回，错误信息如实说明）。
#[tauri::command]
pub fn rename_folder(
    old_dir: String,
    new_dir: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    let exclude = state.exclude_folders()?;
    rename_folder_impl(&root, &old_dir, &new_dir)?;
    let pending = match collect_canvas_updates(&root, &mut |canvas| {
        remap_dir_refs_in_canvas(canvas, &old_dir, &new_dir)
    }) {
        Ok(p) => p,
        Err(e) => {
            // 目录已移动：扫描失败也回滚，防「目录已改名但画布引用仍指向旧路径」的半完成态
            let _ = rename_folder_impl(&root, &new_dir, &old_dir);
            return Err(format!("扫描画布引用失败，重命名已回滚（请重试）：{e}"));
        }
    };
    let old_prefix = format!("{old_dir}/");
    let new_prefix = format!("{new_dir}/");
    let pending_md = match collect_md_link_updates(&root, &exclude, &mut |span: &str| {
        let Some(path) = markdown_link_path(span) else {
            return span.to_string();
        };
        let Some(rest) = path.strip_prefix(&old_prefix) else {
            return span.to_string();
        };
        let label_end = span.find("](").unwrap_or(span.len() - 1);
        format!("{}]({new_prefix}{rest})", &span[..label_end])
    }) {
        Ok(p) => p,
        Err(e) => {
            let _ = rename_folder_impl(&root, &new_dir, &old_dir);
            return Err(format!("扫描笔记内部链接失败，重命名已回滚（请重试）：{e}"));
        }
    };
    if let Err(e) = flush_canvas_updates(&pending) {
        // 尽力回滚：目录移回旧名（部分画布引用可能已写回，错误信息如实说明）
        let _ = rename_folder_impl(&root, &new_dir, &old_dir);
        return Err(format!("更新画布引用失败，重命名已回滚（请重试）：{e}"));
    }
    if let Err(e) = flush_md_updates(&root, &pending_md) {
        let _ = rename_folder_impl(&root, &new_dir, &old_dir);
        return Err(format!("更新笔记内部链接失败，重命名已回滚（请重试）：{e}"));
    }
    Ok(())
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
pub(crate) fn mime_from_ext(file: &str) -> Option<&'static str> {
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

/// 读文件夹图标颜色映射（.atelyx/folder-colors.json，不存在/损坏返回空）。
#[tauri::command]
pub fn read_folder_colors(
    state: State<'_, VaultState>,
) -> Result<HashMap<String, String>, String> {
    let root = state.root()?;
    read_folder_colors_file(&root)
}

/// 写文件夹图标颜色映射（原子写 .atelyx/folder-colors.json，独立于 config.json）。
#[tauri::command]
pub fn write_folder_colors(
    colors: HashMap<String, String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let root = state.root()?;
    write_folder_colors_file(&root, &colors)
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

/// 追加式写会话消息正文 .md（消息增长场景：前端只传新增段，省全量重拼与 IPC 载荷；
/// 文件缺失报错由前端回落全量重写；截断场景仍走 write_chat_messages 全量重写）。
#[tauri::command]
pub fn append_chat_messages(
    state: State<'_, VaultState>,
    file: String,
    segments: Vec<ChatSegment>,
) -> Result<(), String> {
    let root = state.root()?;
    append_chat_messages_file(&root, &file, &segments)
}

/// 删会话消息正文 .md（不存在视为成功——幂等）。
#[tauri::command]
pub fn delete_chat_messages(state: State<'_, VaultState>, file: String) -> Result<(), String> {
    let root = state.root()?;
    delete_chat_messages_file(&root, &file)
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
/// pub(crate)：table 命令的引用扫描复用（rename/move_table_vault）。
pub(crate) fn collect_canvas_updates(
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
    // 链接维护不过滤（排除/隐藏目录内的画布也可能引用文件），exclude 传空
    for (child_rel, is_dir) in read_dir_filtered(&dir, rel, &[])? {
        if is_dir {
            scan_atlx_in(root, &child_rel, update, updates)?;
        } else if child_rel.ends_with(".atlx") {
            let path = root.join(&child_rel);
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
        update_refs_in_canvas(canvas, old_file, new_file)
    })
}

/// 收集需更新 media 节点 file 引用的画布（不写盘）。与 collect_note_ref_updates 对称。
fn collect_attachment_ref_updates(
    root: &Path,
    old_file: &str,
    new_file: &str,
) -> Result<Vec<(PathBuf, CanvasFile)>, String> {
    collect_canvas_updates(root, &mut |canvas| {
        update_refs_in_canvas(canvas, old_file, new_file)
    })
}

/// 收集需更新 table 节点 file 引用的画布（不写盘，rename/move_table_vault 用）。
pub(crate) fn collect_table_ref_updates(
    root: &Path,
    old_file: &str,
    new_file: &str,
) -> Result<Vec<(PathBuf, CanvasFile)>, String> {
    collect_canvas_updates(root, &mut |canvas| {
        update_refs_in_canvas(canvas, old_file, new_file)
    })
}

/// 节点类型 → 引用字段名（text/media/table 节点引用独立文件用 `file`；
/// conversation 节点系统提示词引用 .md 用 `systemPromptFile`）。
fn ref_field_of(node_type: &str) -> Option<&'static str> {
    match node_type {
        "text" | "media" | "table" => Some("file"),
        "conversation" => Some("systemPromptFile"),
        _ => None,
    }
}

/// 更新单个 .atlx 内节点引用（内存中）：按节点类型替换 file/systemPromptFile 命中值，返回是否有变更。
/// 三类引用（笔记 .md / 附件 / 表格 .atb）统一走此函数——旧路径按扩展名天然互斥，合并后行为等价。
fn update_refs_in_canvas(canvas: &mut CanvasFile, old_file: &str, new_file: &str) -> bool {
    let mut changed = false;
    for node in &mut canvas.nodes {
        let Some(field) = ref_field_of(&node.node_type) else {
            continue;
        };
        let Some(obj) = node.data.as_object_mut() else {
            continue;
        };
        if obj.get(field).and_then(|v| v.as_str()) == Some(old_file) {
            obj.insert(field.to_string(), serde_json::Value::String(new_file.to_string()));
            changed = true;
        }
    }
    changed
}

/// 统一写回收集的画布更新（rename 成功后才调用；失败由调用方回滚 rename）。
/// pub(crate)：table 命令的引用写回复用。
pub(crate) fn flush_canvas_updates(updates: &[(PathBuf, CanvasFile)]) -> Result<(), String> {
    for (path, canvas) in updates {
        write_canvas_file(path, canvas)?;
    }
    Ok(())
}

/// 更新单个 .atlx 内的目录前缀引用（内存中）：位于 `old_dir/` 下的 text `file`、
/// media `file`、conversation `systemPromptFile` 替换为 `new_dir/` + 剩余部分。
/// 返回是否有变更。前缀含尾斜杠，防误匹配 `a` 命中 `ab/x.md`。
fn remap_dir_refs_in_canvas(canvas: &mut CanvasFile, old_dir: &str, new_dir: &str) -> bool {
    let old_prefix = format!("{}/", old_dir);
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
            // media 节点附件引用（任意文件）
            "media" => Some("file"),
            // table 节点表格引用（.atb）
            "table" => Some("file"),
            _ => None,
        };
        if let Some(field) = ref_field {
            if let Some(path) = obj.get(field).and_then(|v| v.as_str()) {
                if path.starts_with(&old_prefix) {
                    obj.insert(
                        field.to_string(),
                        serde_json::Value::String(format!(
                            "{new_dir}/{}",
                            &path[old_prefix.len()..]
                        )),
                    );
                    changed = true;
                }
            }
        }
    }
    changed
}
