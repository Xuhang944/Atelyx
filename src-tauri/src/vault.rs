//! 仓库文件读写核心模块。
//!
//! 仓库 = 用户自选文件夹，无数据库，全部文件存储。
//! 文件结构与 .atlx schema 。
//! 本模块只做文件 I/O + 路径校验，不耦合业务语义（text 节点 bodyMd
//! 的剥离/填充在 services/vault 层组合）。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use nanoid::nanoid;
use serde::{Deserialize, Serialize};

/// 兼容字段：旧配置可能含「画布/笔记/附件」三目录名（`.atelyx/config.json` 的 `dirNames`），
/// 保留类型以兼容读取，不驱动任何路径逻辑（仓库为自由文件夹结构）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirNames {
    pub canvases: String,
    pub notes: String,
    pub attachments: String,
}

/// 磁盘文件缓存条目：mtime（纳秒）+ 长度作失效指纹——外部编辑/同步盘改动命中指纹变化，
/// 命中克隆免每次保存重读重解析（乐观锁检查 + createdAt 保留 + 补丁基底共用）。
pub struct CachedFile<T> {
    mtime_nanos: u128,
    len: u64,
    data: T,
}

/// 当前仓库会话状态，由 lib.rs app.manage 注入，命令通过 State<VaultState> 读取。
pub struct VaultState {
    pub session: Mutex<Option<VaultSession>>,
    /// 反链索引缓存：纯内存、磁盘为真相（每次查询按指纹 diff 自愈）；切换仓库时随 set 清空，查询时懒构建。
    pub wiki: Mutex<Option<WikiIndex>>,
    /// 已解析 `.atlx` 缓存（key = 相对仓库根路径）：指纹校验失效，切仓库随 set 清空。
    pub canvas_cache: Mutex<HashMap<String, CachedFile<CanvasFile>>>,
    /// 已解析 `.atb` 缓存（同 canvas_cache）。
    pub table_cache: Mutex<HashMap<String, CachedFile<TableFile>>>,
}

/// 一次仓库会话：根路径 + 该仓库生效的文件面板配置（open_vault/ensure_default_vault 时从配置解析）。
pub struct VaultSession {
    pub root: PathBuf,
    /// 排除文件夹名列表（任何层级的同名文件夹不显示/不监听，`excludeFolders` 配置）。
    pub exclude_folders: Vec<String>,
    /// 附件导入默认文件夹（相对仓库根，可含子路径；None/空 = 仓库根目录）。
    pub attachment_folder: Option<String>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            wiki: Mutex::new(None),
            canvas_cache: Mutex::new(HashMap::new()),
            table_cache: Mutex::new(HashMap::new()),
        }
    }
}

impl VaultState {
    /// 取当前仓库根路径，未打开仓库时返回错误。
    pub fn root(&self) -> Result<PathBuf, String> {
        self.session
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.root.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 取当前仓库生效的排除文件夹列表（缺省 = 空），未打开仓库时返回错误。
    pub fn exclude_folders(&self) -> Result<Vec<String>, String> {
        self.session
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.exclude_folders.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 取当前仓库生效的附件导入文件夹（None = 仓库根目录），未打开仓库时返回错误。
    pub fn attachment_folder(&self) -> Result<Option<String>, String> {
        self.session
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.attachment_folder.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 设置当前仓库会话（canonicalize 消除 `..`/符号链接，保证 safe_join 校验与 watcher 语义一致；
    /// 用 dunce 去除 Windows `\\?\` 长路径前缀，保证存/回传给前端的路径格式统一）。
    /// 同时清空反链索引缓存：不同仓库的索引不混用（查询时懒重建）。
    /// 返回 Result：Mutex poisoned 时向上传播而非静默丢弃（与 root() 策略一致）。
    pub fn set(
        &self,
        root: PathBuf,
        exclude_folders: Vec<String>,
        attachment_folder: Option<String>,
    ) -> Result<(), String> {
        let canonical = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let mut guard = self.session.lock().map_err(|e| e.to_string())?;
        *guard = Some(VaultSession {
            root: canonical,
            exclude_folders,
            attachment_folder,
        });
        // 以下三个辅助锁（wiki/canvas_cache/table_cache）poison 时清空动作无副作用，吞掉即可；
        // 读路径（query/read_cached）对 poison 走 map_err 传播（见 416/433 行），与本处策略一致。
        let _ = self.wiki.lock().map(|mut w| *w = None);
        // 切仓库清空文件缓存：不同仓库的同名相对路径不得混用
        let _ = self.canvas_cache.lock().map(|mut c| c.clear());
        let _ = self.table_cache.lock().map(|mut c| c.clear());
        Ok(())
    }
}

// ===== .atlx 文件结构（对应前端 types/canvas.ts）=====
// data 用 serde_json::Value，不耦合业务字段；rename_all = "camelCase" 对齐前端。

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFile {
    #[serde(default)]
    pub schema: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub viewport: serde_json::Value,
    #[serde(default)]
    pub nodes: Vec<CanvasFileNode>,
    #[serde(default)]
    pub edges: Vec<CanvasFileEdge>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFileNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFileEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_handle: Option<String>,
    /// false = 关联边（无消费语义）；缺省 = 数据流边。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directed: Option<bool>,
    /// 关联边的箭头模式（"none" | "single" | "double"，仅 directed: false 生效；缺省 = 无向）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_mode: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

/// 画布列表行（递归扫描仓库内全部 .atlx 得到，不含拓扑）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFileRow {
    pub id: String,
    pub title: String,
    /// 相对仓库根的 .atlx 路径（画布任意文件夹存放，按真实路径加载/保存）
    pub file: String,
    pub updated_at: i64,
}

/// 仓库文件树节点（`list_vault_tree`，文件面板全仓库树）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    /// 文件名 / 文件夹名
    pub name: String,
    /// 相对仓库根路径（目录不带尾部分隔符；空串 = 仓库根自身）
    pub path: String,
    pub is_dir: bool,
    /// mtime unix 秒
    pub updated_at: i64,
    pub children: Vec<FileTreeNode>,
}

/// 相对路径是否应被过滤：任一路径段以 `.` 开头（隐藏目录/文件，如 `.atelyx`/`.git`/`.obsidian`）
/// 或精确命中排除文件夹列表。文件树与 watcher 共用此判定，保证显示/监听语义一致。
pub fn is_excluded_rel(rel: &str, exclude: &[String]) -> bool {
    rel.split('/').any(|seg| {
        seg.starts_with('.') || exclude.iter().any(|e| e.as_str() == seg)
    })
}

/// 读取目录条目（相对路径 + 是否目录），应用全仓库统一过滤：
/// 隐藏项（`.` 前缀）/ 排除文件夹 / `.tmp` 原子写副产物。递归由各 walker 自行组织
/// （list_tree_in / scan_canvases_in / walk_md_in / scan_atlx_in 共用，过滤规则只维护一处）。
pub(crate) fn read_dir_filtered(
    dir: &Path,
    rel: &str,
    exclude: &[String],
) -> Result<Vec<(String, bool)>, String> {
    let mut out: Vec<(String, bool)> = vec![];
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') || exclude.iter().any(|e| e.as_str() == name) {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir && entry.path().extension().and_then(|s| s.to_str()) == Some("tmp") {
            // 跳过 atomic_write 的 `.tmp` 中间文件（原子写 `path.tmp` → rename 副产物）
            continue;
        }
        out.push((child_rel, is_dir));
    }
    Ok(out)
}

/// 递归枚举仓库文件树（跳过隐藏 `.` 开头 / 排除列表 / `.tmp` 原子写副产物），按 name 升序。
pub fn list_vault_tree(root: &Path, exclude: &[String]) -> Result<Vec<FileTreeNode>, String> {
    list_tree_in(root, "", exclude)
}

fn list_tree_in(
    root: &Path,
    rel: &str,
    exclude: &[String],
) -> Result<Vec<FileTreeNode>, String> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let mut nodes: Vec<FileTreeNode> = vec![];
    for (child_rel, is_dir) in read_dir_filtered(&dir, rel, exclude)? {
        let path = root.join(&child_rel);
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|md| md.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let children = if is_dir {
            list_tree_in(root, &child_rel, exclude)?
        } else {
            vec![]
        };
        nodes.push(FileTreeNode {
            name: rel_last_seg(&child_rel).to_string(),
            path: child_rel,
            is_dir,
            updated_at: mtime,
            children,
        });
    }
    nodes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(nodes)
}

/// 相对路径末段（list_tree_in 展示名用；rel 非空时必有末段）。
fn rel_last_seg(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

// ===== 路径校验 =====

/// 校验相对路径安全并 join 仓库根，返回绝对路径（安全 12）。
/// 拒绝绝对路径 / `..` / 根目录 / 盘符前缀（Windows 下 `PathBuf::join` 遇绝对路径会整体替换，
/// 仅拦 `..` 可被 `C:\x`、`\\server\x`、`\x` 绕过）；join 后再 dunce::canonicalize 父目录
/// 校验落在仓库根内（同时覆盖符号链接逃逸）。文件可能不存在，故只校验父目录。
/// `create_parents`：写路径（write_note / rename 目标）父目录不存在时先建目录
/// （否则 canonicalize 父目录必失败，`write_note` 注释声明的「自动建父目录」不可达）。
pub(crate) fn safe_join(root: &Path, file: &str, create_parents: bool) -> Result<PathBuf, String> {
    if file.is_empty() {
        return Err("非法路径：空路径".to_string());
    }
    let p = Path::new(file);
    if p.is_absolute() {
        return Err(format!("非法路径：绝对路径 ({})", file));
    }
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(seg) => clean.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("非法路径：含越界段 ({})", file));
            }
        }
    }
    let joined = root.join(clean);
    let root_canon = dunce::canonicalize(root).map_err(|_| "仓库根不可达".to_string())?;
    // 最终文件已存在时校验其真实路径仍在仓库根内：目录级穿越已由组件过滤 + 父目录
    // canonicalize 双保险，文件级符号链接（指向仓库外）是最后缺口——canonicalize 解出目标
    // 后 starts_with 拒绝；新建文件（不存在）跳过，父目录校验已覆盖中间目录符号链接。
    if joined.exists() {
        let joined_canon = dunce::canonicalize(&joined)
            .map_err(|e| format!("路径不可达：{} ({})", file, e))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err(format!("路径越界：{}", file));
        }
    }
    let parent = joined.parent().ok_or_else(|| format!("非法路径：{}", file))?;
    if create_parents {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败：{} ({})", file, e))?;
    }
    let parent_canon = dunce::canonicalize(parent).map_err(|e| format!("路径不存在：{} ({})", file, e))?;
    if !parent_canon.starts_with(&root_canon) {
        return Err(format!("路径越界：{}", file));
    }
    Ok(joined)
}

// ===== 仓库初始化 =====

/// 初始化仓库目录结构：仅 `.atelyx/`（无固定 画布/笔记/附件 目录，文件夹由用户自由创建）。
pub fn init_vault_dirs(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root.join(".atelyx")).map_err(|e| e.to_string())
}

// ===== .atlx 读写 =====

/// 读 .atlx 文件并反序列化。
pub fn read_canvas_file(path: &Path) -> Result<CanvasFile, String> {
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let canvas = serde_json::from_str::<CanvasFile>(&json).map_err(|e| e.to_string())?;
    // 私有格式保护：schema 不符即拒绝解析（防外部工具/手改误写）
    if canvas.schema != CANVAS_SCHEMA {
        return Err(format!("画布 schema 不匹配：{}", canvas.schema));
    }
    Ok(canvas)
}

/// 原子写 .atlx：写 `.tmp` → rename 覆盖目标（避免崩溃留下半截文件）。
pub fn write_canvas_file(path: &Path, canvas: &CanvasFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(canvas).map_err(|e| e.to_string())?;
    atomic_write(path, &json)
}

// ===== 已解析文件缓存（.atlx/.atb，写/补丁路径共用）=====

/// 文件 mtime（纳秒）+ 长度指纹；读不到（不存在/IO 错误）返回 None（不命中缓存，调用方按缺失处理）。
fn file_fingerprint(path: &Path) -> Option<(u128, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime, md.len()))
}

/// 带缓存读 .atlx：指纹命中返回克隆，未命中读盘后入缓存。返回（绝对路径, 数据）。
/// 文件缺失/损坏直接透传 read_canvas_file 错误（调用方按路径存在性区分场景）。
pub fn read_canvas_file_cached(
    state: &VaultState,
    root: &Path,
    file: &str,
) -> Result<(PathBuf, CanvasFile), String> {
    let path = safe_join(root, file, false)?;
    if let Some(fp) = file_fingerprint(&path) {
        let mut cache = state.canvas_cache.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.get(file) {
            if entry.mtime_nanos == fp.0 && entry.len == fp.1 {
                return Ok((path, entry.data.clone()));
            }
        }
        let data = read_canvas_file(&path)?;
        cache.insert(
            file.to_string(),
            CachedFile {
                mtime_nanos: fp.0,
                len: fp.1,
                data: data.clone(),
            },
        );
        return Ok((path, data));
    }
    Ok((path.clone(), read_canvas_file(&path)?))
}

/// 带缓存读 .atb（语义同 read_canvas_file_cached）。
pub fn read_table_file_cached(
    state: &VaultState,
    root: &Path,
    file: &str,
) -> Result<(PathBuf, TableFile), String> {
    let path = safe_join(root, file, false)?;
    if let Some(fp) = file_fingerprint(&path) {
        let mut cache = state.table_cache.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.get(file) {
            if entry.mtime_nanos == fp.0 && entry.len == fp.1 {
                return Ok((path, entry.data.clone()));
            }
        }
        let data = read_table_file(&path)?;
        cache.insert(
            file.to_string(),
            CachedFile {
                mtime_nanos: fp.0,
                len: fp.1,
                data: data.clone(),
            },
        );
        return Ok((path, data));
    }
    Ok((path.clone(), read_table_file(&path)?))
}

/// 写盘成功后更新缓存（file = 写盘后的相对路径；重命名路径变化时先清旧 key）。
/// 锁 poison 静默跳过：缓存是纯优化，丢一次命中下次读盘即可（读路径对 poison 传播错误，见 read_*_cached）。
pub fn cache_put_canvas(state: &VaultState, path: &Path, file: &str, data: &CanvasFile) {
    if let Ok(mut cache) = state.canvas_cache.lock() {
        cache.retain(|k, _| k != file);
        if let Some(fp) = file_fingerprint(path) {
            cache.insert(
                file.to_string(),
                CachedFile {
                    mtime_nanos: fp.0,
                    len: fp.1,
                    data: data.clone(),
                },
            );
        }
    }
}

/// 写盘成功后更新 .atb 缓存（语义同 cache_put_canvas，锁 poison 静默跳过）。
pub fn cache_put_table(state: &VaultState, path: &Path, file: &str, data: &TableFile) {
    if let Ok(mut cache) = state.table_cache.lock() {
        cache.retain(|k, _| k != file);
        if let Some(fp) = file_fingerprint(path) {
            cache.insert(
                file.to_string(),
                CachedFile {
                    mtime_nanos: fp.0,
                    len: fp.1,
                    data: data.clone(),
                },
            );
        }
    }
}

/// 从画布解析缓存移除指定相对路径（重命名/移动/删除后旧路径键残留清理；不存在 = 无操作）。
/// 残留键因指纹（mtime+len）失效本不会被命中，清理仅为防长会话内存累积。
pub fn cache_evict_canvas(state: &VaultState, file: &str) {
    if let Ok(mut cache) = state.canvas_cache.lock() {
        cache.remove(file);
    }
}

/// 从 .atb 解析缓存移除指定相对路径（语义同 cache_evict_canvas）。
pub fn cache_evict_table(state: &VaultState, file: &str) {
    if let Ok(mut cache) = state.table_cache.lock() {
        cache.remove(file);
    }
}

/// 由旧相对路径 + 新标题算新相对路径（同目录改文件名；净化规则与落盘一致）。
/// 画布/表格共用（ext = "atlx" / "atb"）。
pub fn rel_with_new_title(old_file: &str, new_title: &str, ext: &str) -> String {
    let filename = format!("{}.{ext}", sanitize_filename(new_title));
    match old_file.rfind('/') {
        Some(i) => format!("{}/{}", &old_file[..i], filename),
        None => filename,
    }
}

/// 两路径是否指向同一物理文件（case-only 重命名在大小写不敏感文件系统上的场景）。
/// 都 canonicalize 成功且相等才豁免；任一失败（身份不明）不豁免（宁可拒绝覆盖，不可删错文件）。
/// 画布/表格写路径共用：Windows NTFS 下 `Foo.atlx` → `foo.atlx` 新旧路径是同一文件，
/// 写新后删旧会删掉刚写入的文件（删即丢数据）。
pub fn same_physical_file(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 画布增量保存补丁（对应前端 types/canvas.ts 的 CanvasPatch）：只含变化/新增/删除的实体，
/// 按稳定 id 合并——removed 幂等（缺 id 不报错），upsert 覆盖同 id 或追加。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPatch {
    /// 画布 id（防串文件守卫）。
    pub id: String,
    /// 标题变化时更新（title 变更 = 同目录改文件名，写盘后返回新相对路径）。
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub upsert_nodes: Vec<CanvasFileNode>,
    #[serde(default)]
    pub removed_node_ids: Vec<String>,
    #[serde(default)]
    pub upsert_edges: Vec<CanvasFileEdge>,
    #[serde(default)]
    pub removed_edge_ids: Vec<String>,
}

/// 表格增量保存补丁（对应前端 types/table.ts 的 TablePatch）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TablePatch {
    /// 表格 id（防串文件守卫）。
    pub id: String,
    /// 标题变化时更新（title 变更 = 同目录改文件名 + 同步画布 table 节点引用）。
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub upsert_fields: Vec<TableField>,
    #[serde(default)]
    pub removed_field_ids: Vec<String>,
    #[serde(default)]
    pub upsert_rows: Vec<TableRow>,
    #[serde(default)]
    pub removed_row_ids: Vec<String>,
    /// 字段 id 全序（与上次落盘序列不同时携带；排序是数组属性，id 合并无法表达，须显式重排）。
    #[serde(default)]
    pub field_order: Option<Vec<String>>,
    /// 行 id 全序（同上）。
    #[serde(default)]
    pub row_order: Option<Vec<String>>,
}

/// 按 id 顺序重排数组（稳定排序）：order 未出现的 id（同批删除/对端新增）保持相对顺序置于末尾。
/// 用于补丁合并后应用 field_order/row_order——拖拽排序/复制行/左右插列的顺序变化落盘。
pub fn reorder_by<T>(items: &mut Vec<T>, order: &[String], key: impl Fn(&T) -> &str) {
    if items.len() <= 1 {
        return;
    }
    let rank: HashMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    items.sort_by_key(|item| rank.get(key(item)).copied().unwrap_or(usize::MAX));
}

/// 递归扫描仓库内全部 `.atlx`（跳过隐藏/排除目录与 `.tmp`），返回列表行（按 updatedAt 倒序）。
/// 画布任意文件夹存放：行带 `file`（相对仓库根路径，文件面板按路径打开）。
pub fn list_canvas_files(root: &Path, exclude: &[String]) -> Result<Vec<CanvasFileRow>, String> {
    let mut rows: Vec<CanvasFileRow> = vec![];
    scan_canvases_in(root, "", exclude, &mut rows)?;
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

fn scan_canvases_in(
    root: &Path,
    rel: &str,
    exclude: &[String],
    rows: &mut Vec<CanvasFileRow>,
) -> Result<(), String> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    for (child_rel, is_dir) in read_dir_filtered(&dir, rel, exclude)? {
        if is_dir {
            scan_canvases_in(root, &child_rel, exclude, rows)?;
        } else if child_rel.ends_with(".atlx") {
            // 完整解析取 id/title/updatedAt（.atlx 文件不大，无需流式）
            let path = root.join(&child_rel);
            if let Ok(canvas) = read_canvas_file(&path) {
                rows.push(CanvasFileRow {
                    id: canvas.id,
                    title: canvas.title,
                    file: child_rel,
                    updated_at: canvas.updated_at,
                });
            }
        }
    }
    Ok(())
}

// ===== .atb 表格文件结构（对应前端 types/table.ts）=====
// values 用 serde_json::Map（值类型随字段类型：string/number/string[]），不耦合单元格业务。

/// `.atb` 表格文件（schema `atelyx-table/v1`）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableFile {
    #[serde(default)]
    pub schema: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub fields: Vec<TableField>,
    #[serde(default)]
    pub rows: Vec<TableRow>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableField {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    /// singleSelect 的选项列表（其他类型无此字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// 用户拖拽调整后的列宽（px；缺省 = 前端按字段名自适应）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    /// 状态栏列自动计算类型（sum/avg/max/min/count；缺省 = 无计算）。
    /// 必须在此显式声明，否则 serde 反序列化会丢弃前端传来的该字段，写盘丢失。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calc_type: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TableRow {
    pub id: String,
    /// 单元格值按字段 id 存（缺 key = 空单元格）。
    #[serde(default)]
    pub values: serde_json::Map<String, serde_json::Value>,
    /// 用户拖拽调整后的行高（px；缺省 = 前端按内容自然撑开）。
    /// 必须在此显式声明，否则 serde 反序列化会丢弃前端传来的该字段，写盘丢失。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// 读 .atb 文件并反序列化（schema 校验同 .atlx 私有格式保护）。
pub fn read_table_file(path: &Path) -> Result<TableFile, String> {
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let table = serde_json::from_str::<TableFile>(&json).map_err(|e| e.to_string())?;
    if table.schema != TABLE_SCHEMA {
        return Err(format!("表格 schema 不匹配：{}", table.schema));
    }
    Ok(table)
}

/// 原子写 .atb：写 `.tmp` → rename 覆盖目标（同 write_canvas_file）。
pub fn write_table_file(path: &Path, table: &TableFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(table).map_err(|e| e.to_string())?;
    atomic_write(path, &json)
}

// ===== 笔记/*.md 读写 =====

pub fn read_note(root: &Path, file: &str) -> Result<String, String> {
    let path = safe_join(root, file, false)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 原子写 .md（同时建父目录）。
pub fn write_note(root: &Path, file: &str, content: &str) -> Result<(), String> {
    let path = safe_join(root, file, true)?;
    atomic_write(&path, content)
}

/// 重命名 .md 文件（不更新 .atlx 引用，链接维护由 commands 层组合）。
/// 通用：附件重命名也复用此函数（路径校验与建父目录逻辑相同）。
pub fn rename_note_file(root: &Path, old_file: &str, new_file: &str) -> Result<(), String> {
    let old_path = safe_join(root, old_file, false)?;
    let new_path = safe_join(root, new_file, true)?;
    if !old_path.exists() {
        return Err(format!("源文件不存在：{}", old_file));
    }
    // 只允许重命名普通文件：目录名传入时 fs::rename 会整个移动目录（delete 因 remove_file 安全，rename 无此保护）
    if !old_path.is_file() {
        return Err(format!("源不是文件：{}", old_file));
    }
    // 目标已存在直接拒绝（Linux/macOS 的 fs::rename 会静默覆盖，Windows 会报错但语义不一）；
    // 前端 dedupe 已防重名，此处兜底并发/外部创建。
    // 豁免 case-only 重命名（`note.md`→`Note.md`）：大小写不敏感文件系统上 exists() 解析到同一文件，
    // 两个 canonicalize 都成功且相等才豁免；任一失败（身份不明）不豁免，宁可拒绝不可覆盖
    let same_file = match (dunce::canonicalize(&old_path), dunce::canonicalize(&new_path)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if new_path.exists() && !same_file {
        return Err(format!("目标文件已存在：{}", new_file));
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

/// 删除仓库内文件（按相对路径，safe_join 防穿越）。用于 delete_note / delete_attachment。
pub fn delete_vault_file(root: &Path, file: &str) -> Result<(), String> {
    let path = safe_join(root, file, false)?;
    if !path.exists() {
        return Err(format!("文件不存在：{}", file));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// 读仓库内文件字节（按相对路径，safe_join 防穿越）。用于 read_attachment_data_url。
pub fn read_file_bytes(root: &Path, file: &str) -> Result<Vec<u8>, String> {
    let path = safe_join(root, file, false)?;
    std::fs::read(&path).map_err(|e| e.to_string())
}

/// 把系统文件导入仓库 `folder/`（folder 为空 = 仓库根目录），文件名净化 + 防重名递增后缀。
/// 返回相对路径 `<folder>/<name>`（folder 为空时返回 `<name>`）。
/// folder 经 safe_join 校验（防配置手改含 `..` 越界）并自动建目录。
pub fn import_attachment(
    root: &Path,
    folder: &str,
    src: &Path,
    name: &str,
) -> Result<String, String> {
    let dir = if folder.is_empty() {
        root.to_path_buf()
    } else {
        safe_join(root, folder, true)?
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = sanitize_filename(name);
    let base = if base.is_empty() { "未命名".to_string() } else { base };
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (base[..i].to_string(), base[i..].to_string()),
        _ => (base.clone(), String::new()),
    };
    let mut dest_name = format!("{}{}", stem, ext);
    let mut n = 1;
    while dir.join(&dest_name).exists() {
        n += 1;
        dest_name = format!("{}-{}{}", stem, n, ext);
    }
    let dest = dir.join(&dest_name);
    if src != dest {
        std::fs::copy(src, &dest).map_err(|e| format!("复制文件失败：{e}"))?;
    }
    if folder.is_empty() {
        Ok(dest_name)
    } else {
        Ok(format!("{folder}/{dest_name}"))
    }
}

// ===== 仓库级配置（.atelyx/config.json）=====

/// 供应商下的单个模型：id = API 请求用的模型名；nickname = 可选显示昵称（缺省 = id）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
}

/// 仓库级 AI 供应商（磁盘格式，默认**不含 api_key**——key 走 keychain 条目
/// `provider-<vaultId>-<id>`；仅 `syncKeys` 开启时随仓库落盘 apiKey，多设备同步）。
/// 运行时含 key 的 `ProviderConfig` 由前端 `settingsStore` 填充。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 多模型列表（一个供应商多个模型，含可选昵称）。
    #[serde(default)]
    pub models: Vec<VaultModel>,
    /// API key（仅 syncKeys 开启时随仓库落盘/读取；关闭时前端剥离不写）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// 仓库级搜索源配置（默认**不含 API key**——Tavily key 走 keychain 条目
/// `provider-<vaultId>-search-tavily`；仅 `syncKeys` 开启时随仓库落盘 tavily_api_key）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub searxng_url: String,
    /// Tavily API key（仅 syncKeys 开启时随仓库落盘/读取；关闭时前端剥离不写）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tavily_api_key: Option<String>,
}

/// 仓库级配置（默认**不含 API key**——key 走 keychain，条目按仓库隔离；
/// 仅 `syncKeys` 开启时 providers/search 落盘 key 字段，随仓库同步多设备）。
/// 主题/强调色/字号/字体/自动恢复开关为应用级（`commands/global.rs` 的 `GlobalConfig`）。
/// serde 类型层守边界：未开启时前端剥离 key 字段再写盘；
/// `skip_serializing_if` 让无覆盖字段不落盘，保持 config.json 干净（{} = 无覆盖）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    /// 仓库级默认模型（模型服务 tab 配置；缺省 = 未指定，跟随默认的对话请求报错提示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 仓库级 AI 供应商列表（默认无 key；key 走 keychain 条目 `provider-<vaultId>-<id>`，
    /// `syncKeys` 开启时随仓库落盘 apiKey）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<VaultProvider>>,
    /// 仓库级搜索源配置（默认无 key；Tavily key 走 keychain 条目
    /// `provider-<vaultId>-search-tavily`，`syncKeys` 开启时随仓库落盘 tavily_api_key）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<VaultSearchConfig>,
    /// API key 是否随仓库保存（多设备同步）：开启后 key 明文落盘本文件随仓库同步；
    /// 缺省 false = key 仅存本机 keychain（按仓库隔离）。开启有泄露风险（仓库被公开/云盘共享）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_keys: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_explorer_sort: Option<String>,
    /// 兼容字段：仓库三根目录名（自由文件夹结构不使用，仅兼容读取旧配置）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir_names: Option<DirNames>,
    /// 文件面板排除的文件夹名（任何层级的同名文件夹不显示/不监听；设置页逗号分隔输入转数组）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_folders: Option<Vec<String>>,
    /// 附件导入默认文件夹（相对仓库根，可含子路径如 `assets/img`；缺省/空 = 仓库根目录）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_folder: Option<String>,
    /// 仓库稳定 ID（首次 open_vault 生成，之后固定；进仓库时动态读取，
    /// 用于前端识别「内存会话/画布状态属于哪个仓库」，防跨仓库搞混）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    /// 宽松换行：开启时预览模式单个换行符渲染为换行；关闭时按 Markdown 标准视为空格。缺省 = true（前端默认）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soft_line_break: Option<bool>,
    /// 话题自动命名开关（缺省 true = 开启）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_naming_enabled: Option<bool>,
    /// 话题自动命名模型（缺省 = 跟随默认模型；指定后命名用该模型，话题命名一般用小模型）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_naming_model: Option<EditorChatModelOverride>,
}

pub fn read_vault_config(root: &Path) -> Result<VaultConfig, String> {
    let path = root.join(".atelyx").join("config.json");
    if !path.exists() {
        return Ok(VaultConfig::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // 与 read_global_config 一致：解析失败降级为默认配置（手编辑损坏不阻塞仓库打开），IO 错误仍上报
    Ok(serde_json::from_str::<VaultConfig>(&json).unwrap_or_default())
}

pub fn write_vault_config(root: &Path, config: &VaultConfig) -> Result<(), String> {
    let path = root.join(".atelyx").join("config.json");
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== 系统提示词标记（.atelyx/prompt-notes.json，独立于 config.json）=====
// config.json 只保存仓库配置；标记列表单独落盘，避免混入配置字段。

/// 读系统提示词标记列表（不存在/解析失败返回空——手编辑损坏不阻塞，与 config 同策略）。
/// 内容为相对仓库根的 `.md` 路径数组（如 `["笔记/提示词.md"]`）。
pub fn read_prompt_notes_file(root: &Path) -> Result<Vec<String>, String> {
    let path = root.join(".atelyx").join("prompt-notes.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<Vec<String>>(&json).unwrap_or_default())
}

/// 写系统提示词标记列表（原子写 .atelyx/prompt-notes.json）。
pub fn write_prompt_notes_file(root: &Path, files: &[String]) -> Result<(), String> {
    let path = root.join(".atelyx").join("prompt-notes.json");
    let json = serde_json::to_string_pretty(files).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== Agent 配置（.atelyx/agents.json，独立于 config.json）=====
// Agent = 可复用对话预设（名称 + 系统提示词 + 工具），对话节点/面板按 id 引用；
// 单独落盘避免混入配置字段（与 prompt-notes.json 同策略）。

/// 单条 Agent 配置（字段命名与前端 types/agent.ts 对齐，camelCase）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    /// 引用已注册提示词笔记（相对仓库根 `.md` 路径，发送时实时读正文注入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_file: Option<String>,
    /// 启用的工具 id 列表（空数组 = 不带工具）。
    #[serde(default)]
    pub tools: Vec<String>,
    /// 预置标记（缺省 = 用户自建；预置 Agent 不可删除）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
}

/// Agent 配置文件根结构（带 schema 便于后续演进）。
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AgentConfigFile {
    pub schema: String,
    pub agents: Vec<AgentConfig>,
}

/// 读 Agent 配置列表（不存在/解析失败返回空——手编辑损坏不阻塞，与 prompt-notes 同策略）。
pub fn read_agents_file(root: &Path) -> Result<Vec<AgentConfig>, String> {
    let path = root.join(".atelyx").join("agents.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<AgentConfigFile>(&json)
        .map(|f| f.agents)
        .unwrap_or_default())
}

/// 写 Agent 配置列表（原子写 .atelyx/agents.json）。
pub fn write_agents_file(root: &Path, agents: &[AgentConfig]) -> Result<(), String> {
    let path = root.join(".atelyx").join("agents.json");
    let file = AgentConfigFile {
        schema: "atelyx-agents/v1".to_string(),
        agents: agents.to_vec(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== 文件夹图标颜色（.atelyx/folder-colors.json，独立于 config.json）=====
// config.json 只保存仓库配置；文件夹颜色单独落盘，避免混入配置字段（与 prompt-notes.json 同策略）。

/// 读文件夹图标颜色映射（相对仓库根路径 → hex 色；不存在/解析失败返回空——手编辑损坏不阻塞）。
pub fn read_folder_colors_file(root: &Path) -> Result<HashMap<String, String>, String> {
    let path = root.join(".atelyx").join("folder-colors.json");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<HashMap<String, String>>(&json).unwrap_or_default())
}

/// 写文件夹图标颜色映射（原子写 .atelyx/folder-colors.json）。
pub fn write_folder_colors_file(
    root: &Path,
    colors: &HashMap<String, String>,
) -> Result<(), String> {
    let path = root.join(".atelyx").join("folder-colors.json");
    let json = serde_json::to_string_pretty(colors).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== AI 对话面板会话（.atelyx/editor-chats.json）=====
// 单一全局历史：全部会话扁平存放，不按笔记归属；不含 API key（key 只进全局 keychain）。
// 该文件不在 watcher 监听范围（watcher 只监听 画布/笔记/附件 三目录），自写无回环问题。

/// editor-chats.json 的 schema 版本（与前端 types/chat.ts 的 EDITOR_CHATS_SCHEMA 对齐）。
pub const EDITOR_CHATS_SCHEMA: &str = "atelyx-editor-chats/v3";

/// 会话消息正文 .jsonl 目录（相对仓库根；位于 `.atelyx/` 下——watcher 不监听、文件面板不显示，无自写回环）。
pub const CHAT_HISTORY_DIR: &str = ".atelyx/对话历史";

/// 单个会话（首条 user 消息前缀作标题，历史列表展示）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorChatSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 引用的 Agent 配置 id（仓库级 `.atelyx/agents.json`；发送时实时解析系统提示词/工具）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// 系统提示词笔记引用（遗留字段：仅兼容读取，不再注入；缺省按预置「对话」Agent 处理）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_file: Option<String>,
    /// 已注入上下文的笔记（防重复注入：同一笔记只注入一次，更换笔记才再次注入；仅会话运行期内有效，不落盘）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injected_note_file: Option<String>,
    /// 消息正文 .jsonl 相对仓库根路径（`.atelyx/对话历史/<会话 id>.jsonl`）
    #[serde(default)]
    pub file: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 面板级模型覆盖（优先于仓库默认模型）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorChatModelOverride {
    pub provider_id: String,
    pub model: String,
}

/// editor-chats.json 根结构。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorChatsFile {
    pub schema: String,
    #[serde(default)]
    pub sessions: Vec<EditorChatSession>,
    /// 当前激活会话 id（重启后恢复；null = 由前端建空会话）。
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub model_override: Option<EditorChatModelOverride>,
    /// 面板级推理等级覆盖（off/low/medium/high；null = 不指定/跟随默认；与模型覆盖正交）。
    #[serde(default)]
    pub effort_override: Option<String>,
}

/// 读 AI 对话面板会话文件（不存在/解析失败返回默认——手编辑损坏不阻塞面板）。
pub fn read_editor_chats_file(root: &Path) -> Result<EditorChatsFile, String> {
    let path = root.join(".atelyx").join("editor-chats.json");
    if !path.exists() {
        return Ok(EditorChatsFile::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file = serde_json::from_str::<EditorChatsFile>(&json).unwrap_or_default();
    // schema 校验：只认 v3——旧版存量（v1/v2）开发阶段不迁移，视为空历史（不报错）
    if file.schema != EDITOR_CHATS_SCHEMA {
        return Ok(EditorChatsFile::default());
    }
    Ok(file)
}

/// 写 AI 对话面板会话文件（原子写 .atelyx/editor-chats.json）。
pub fn write_editor_chats_file(root: &Path, file: &EditorChatsFile) -> Result<(), String> {
    let path = root.join(".atelyx").join("editor-chats.json");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== 会话消息正文（.atelyx/对话历史/*.jsonl）=====

/// 校验并定位会话消息正文路径：必须位于 `.atelyx/对话历史/` 下且以 .jsonl 结尾（防越权读写任意文件）。
fn chat_messages_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    let prefix = format!("{}/", CHAT_HISTORY_DIR);
    if !file.starts_with(&prefix) || !file.ends_with(".jsonl") {
        return Err(format!("非法会话消息路径：{}", file));
    }
    safe_join(root, file, false)
}

/// 读会话消息正文 .jsonl（文件不存在报错，由前端 catch 降级为空消息）。
pub fn read_chat_messages_file(root: &Path, file: &str) -> Result<String, String> {
    let path = chat_messages_path(root, file)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 写会话消息正文 .jsonl（自动建 `.atelyx/对话历史/` 目录 + 原子写）。
pub fn write_chat_messages_file(root: &Path, file: &str, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(root.join(CHAT_HISTORY_DIR)).map_err(|e| e.to_string())?;
    let path = chat_messages_path(root, file)?;
    atomic_write(&path, content)
}

/// 追加记录：消息 .jsonl 的增量（一行一条消息记录，与前端 serializeChatMessages 字段对齐；
/// refs/steps 透传 JSON——Rust 侧不镜像嵌套类型，序列化时按字段名原样写出）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: String,
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// user 消息气泡显示用：发送时的原始输入，与 content 分离（content 可能含注入的笔记全文）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_content: Option<String>,
    /// 发送时拖入的笔记引用（随记录持久化，重开会话恢复 @chip）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refs: Option<serde_json::Value>,
    /// Agent 步进（思考/工具交错；工具步含调用过程，随记录持久化恢复展示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<serde_json::Value>,
    pub created_at: i64,
}

/// 追加式写会话消息正文 .jsonl（消息增长场景：前端只传新增记录，每记录一行紧凑 JSON，省全量重拼与 IPC 载荷）。
/// 文件缺失直接报错（前端回落全量重写重建历史——新建会话首次落盘走全量写路径，追加永不该建新文件）。
/// 截断场景（回到此处/重新生成删消息）仍走 write_chat_messages_file 全量重写。
/// 读旧内容 + 拼接 + 原子写：失败时文件保持原状，前端按「写成功才推进基线」重试。
pub fn append_chat_messages_file(
    root: &Path,
    file: &str,
    records: &[ChatMessageRecord],
) -> Result<(), String> {
    std::fs::create_dir_all(root.join(CHAT_HISTORY_DIR)).map_err(|e| e.to_string())?;
    let path = chat_messages_path(root, file)?;
    if !path.exists() {
        return Err("会话消息文件缺失，请重写".to_string());
    }
    let mut content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    for record in records {
        let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
        content.push_str(&line);
        content.push('\n');
    }
    atomic_write(&path, &content)
}

/// 删会话消息正文 .jsonl（不存在视为成功——幂等，删除会话时调用）。
pub fn delete_chat_messages_file(root: &Path, file: &str) -> Result<(), String> {
    let path = chat_messages_path(root, file)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ===== 工具 =====

/// 原子写：写唯一临时文件 → fsync → rename 覆盖目标。
/// - 临时名带纳秒时间戳后缀：并发写同一目标不交叉同一 tmp（乐观锁 TOCTOU 之外的最后防线）；
///   保持 `.tmp` 扩展名，让 watcher 能过滤自写副产物。
/// - 写后 sync_all：崩溃/断电时 rename 已提交但数据未刷盘会丢最后一次保存。
/// - rename 失败时清理临时文件，避免残留。
/// pub(crate)：commands/global.rs 的全局配置/UI 状态写盘复用（保证全项目同一 durability 语义）。
pub(crate) fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), uniq));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败：{e}")
    })
}

/// 文件名净化：替换 `/\:*?"<>|` 为 `_`（对应前端 utils/filename.ts），
/// 去首尾空白；Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含任意扩展名）与尾部点/空格
/// 补 `_` 前缀/后缀避免 I/O 失败（`CON.md`、`foo.` 在 Windows 会被拒绝或截断）。
pub fn sanitize_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    let stem = trimmed.split('.').next().unwrap_or("");
    if is_windows_reserved_name(stem) {
        format!("_{}", trimmed)
    } else if trimmed.ends_with(['.', ' ']) {
        format!("{}_", trimmed)
    } else {
        trimmed.to_string()
    }
}

/// Windows 保留设备名（不带扩展名时同样保留，如 `CON` / `CON.txt` 均非法）。
fn is_windows_reserved_name(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    matches!(
        up.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

/// 新建文件夹（相对仓库根路径，如 `项目A/素材`），自动建父目录；已存在则幂等返回。
/// dir 经 safe_join 校验（拒绝 `..`/绝对路径越界）并建父目录。
pub fn create_folder(root: &Path, dir: &str) -> Result<String, String> {
    let path = safe_join(root, dir, true)?;
    if !path.is_dir() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string())
}

/// 删除文件夹的结果（结构化返回：空目录直接删；非空且未带 force 时返回需确认信息供前端弹窗）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderResult {
    /// 本次是否已删除
    pub deleted: bool,
    /// 目录非空且未带 force：需用户确认后以 force=true 再次调用
    pub needs_confirm: bool,
    /// 目录内条目数（递归计数，含子目录与隐藏文件）
    pub item_count: usize,
}

/// 删除文件夹（相对仓库根路径）。force=false 只删空目录——非空返回
/// `needs_confirm`（含递归条目数）供前端弹窗确认后以 force=true 重试；
/// force=true 递归删除全部内容。dir 为空（仓库根）拒绝，防误删整个仓库。
pub fn delete_folder(root: &Path, dir: &str, force: bool) -> Result<DeleteFolderResult, String> {
    if dir.is_empty() {
        return Err("非法路径：不能删除仓库根目录".to_string());
    }
    let path = safe_join(root, dir, false)?;
    if !path.is_dir() {
        return Err(format!("目录不存在：{}", dir));
    }
    let item_count = count_dir_items(&path)?;
    if !force && item_count > 0 {
        return Ok(DeleteFolderResult {
            deleted: false,
            needs_confirm: true,
            item_count,
        });
    }
    if force {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_dir(&path).map_err(|e| e.to_string())?;
    }
    Ok(DeleteFolderResult {
        deleted: true,
        needs_confirm: false,
        item_count,
    })
}

/// 递归统计目录内条目数（含隐藏文件与子目录；删除确认弹窗文案用）。
fn count_dir_items(dir: &Path) -> Result<usize, String> {
    let mut count = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        count += 1;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            count += count_dir_items(&entry.path())?;
        }
    }
    Ok(count)
}

/// 移动整个目录到新相对路径（校验 + 防覆盖；`fs::rename` 对目录同样生效）。
/// 不更新 .atlx 引用——引用前缀维护由 commands 层组合（与 rename_note 同模式）。
pub fn rename_folder(root: &Path, old_dir: &str, new_dir: &str) -> Result<(), String> {
    if old_dir.is_empty() || new_dir.is_empty() {
        return Err("非法路径：目录为空".to_string());
    }
    let old_path = safe_join(root, old_dir, false)?;
    let new_path = safe_join(root, new_dir, true)?;
    if !old_path.is_dir() {
        return Err(format!("目录不存在：{}", old_dir));
    }
    // 目标已存在拒绝（防覆盖丢数据；前端 dedupe 已防重名，此处兜底并发/外部创建）
    if new_path.exists() {
        return Err(format!("目标目录已存在：{}", new_dir));
    }
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

/// 复制整个目录到新相对路径（递归复制全部内容含隐藏文件；校验 + 防覆盖，与 rename_folder 对称）。
/// 副本是独立目录，内部 .atlx 引用仍是相对路径、随目录整体复制，无需链接维护；
/// 目录内画布/表格重新生成 id（防同 id 双文件歧义：画布标签按 id 去重、协作合并按 id 身份）。
pub fn copy_folder(root: &Path, old_dir: &str, new_dir: &str) -> Result<(), String> {
    if old_dir.is_empty() || new_dir.is_empty() {
        return Err("非法路径：目录为空".to_string());
    }
    let old_path = safe_join(root, old_dir, false)?;
    let new_path = safe_join(root, new_dir, true)?;
    if !old_path.is_dir() {
        return Err(format!("目录不存在：{}", old_dir));
    }
    // 目标已存在拒绝（防覆盖丢数据；前端 dedupe 已防重名，此处兜底并发/外部创建）
    if new_path.exists() {
        return Err(format!("目标目录已存在：{}", new_dir));
    }
    if let Err(e) = copy_dir_all(&old_path, &new_path) {
        // 复制中途失败：清理残缺副本，防半成品目录残留在文件树
        let _ = std::fs::remove_dir_all(&new_path);
        return Err(format!("复制目录失败：{e}"));
    }
    if let Err(e) = regenerate_ids_in(&new_path) {
        let _ = std::fs::remove_dir_all(&new_path);
        return Err(format!("复制目录失败：{e}"));
    }
    Ok(())
}

/// 递归复制目录内容（含隐藏文件与子目录）。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 重写目录内全部 `.atlx`/`.atb` 的 id 为新值（title 保持原样：副本文件名与原件不同、
/// 内部标题与各自文件名仍一致）。读失败的文件视为损坏跳过（与画布扫描同策略）。
fn regenerate_ids_in(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            regenerate_ids_in(&path)?;
        } else {
            regenerate_file_id(&path)?;
        }
    }
    Ok(())
}

/// 重写单个 `.atlx`/`.atb` 的 id 为新值（单文件复制副本防同 id 双文件歧义：
/// 画布标签按 id 去重、协作合并按 id 身份；与 copy_folder 的 regenerate_ids_in 同语义）。
/// 非这两种扩展名/读失败（损坏文件）原样保留，不阻断复制。
pub fn regenerate_file_id(path: &Path) -> Result<(), String> {
    let ext = path.extension().and_then(|s| s.to_str());
    if ext == Some("atlx") {
        if let Ok(mut canvas) = read_canvas_file(path) {
            canvas.id = nanoid!();
            write_canvas_file(path, &canvas)?;
        }
    } else if ext == Some("atb") {
        if let Ok(mut table) = read_table_file(path) {
            table.id = nanoid!();
            write_table_file(path, &table)?;
        }
    }
    Ok(())
}

/// 仓库显示名：优先取路径最后一段（文件夹名）；网络共享根（`\\server\share`，无更深子目录）
/// 与尾部带分隔符的路径 `file_name()` 为 None——回退为去尾部分隔符后取最后一段（UNC 根取 share 名）。
/// 本地盘根（`E:\`）回退为盘符（`E:`），少见但避免空白名。
pub fn vault_display_name(root: &Path) -> String {
    if let Some(n) = root.file_name() {
        if let Some(s) = n.to_str() {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    root.to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// `.atlx` schema 版本号（对应前端 `types/canvas.ts` 的 `CANVAS_SCHEMA`）。
pub const CANVAS_SCHEMA: &str = "atelyx-canvas/v1";

/// `.atb` schema 版本号（对应前端 `types/table.ts` 的 `TABLE_SCHEMA`）。
pub const TABLE_SCHEMA: &str = "atelyx-table/v1";

// ===== 反链索引（纯内存缓存，磁盘为真相）=====
//
// 设计要点（为多人实时协作预留的红线）：
// - 索引只读派生、绝不落盘仓库（不产生同步冲突文件），永远可从磁盘全量重建（幂等）；
// - 每次查询按 (mtime, size) 指纹 diff 增量刷新：只重读变化/新增的 .md，缺失条目剔除——
//   外部编辑/重命名/删除/文件夹移动全部自愈，无需独立的失效管道（事件驱动索引会漏事件、丢 debounce）；
// - 构建/刷新集中在 refresh_wiki_index 一个函数，未来协作层「内存文档即真相」时只换刷新触发源。
//
// 提取两种链接写法：`[[target]]`/`[[target|别名]]` 与 `[label](path)`（图片 `![..](..)` 不算反链）。

/// 反链行：引用方笔记的相对仓库根路径 + 标题（scan_wiki_backlinks 返回，对应前端 types/canvas.ts）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRow {
    pub file: String,
    pub title: String,
}

/// 单条提取结果：name 与 path 二选一（`[[..]]` 为 name 形式，`[..](..)` 为 path 形式）。
struct WikiRef {
    name: Option<String>,
    path: Option<String>,
}

/// 文件指纹：mtime 毫秒 + 大小（本机本地语义；同步/检出后 mtime 变化 → 自然触发重读自愈）。
#[derive(PartialEq)]
struct FileStamp {
    mtime_ms: u128,
    size: u64,
}

/// 反链索引：rel 路径 → 指纹 + 已提取引用（倒排查询时遍历，纯内存迭代无 I/O，无需预建倒排表）。
#[derive(Default)]
pub struct WikiIndex {
    files: HashMap<String, FileStamp>,
    refs: HashMap<String, Vec<WikiRef>>,
}

/// 增量刷新索引：stat 遍历（快），只重读指纹变化的文件；消失文件从索引剔除。
pub fn refresh_wiki_index(
    root: &Path,
    exclude: &[String],
    index: &mut WikiIndex,
) -> Result<(), String> {
    let mut seen: HashSet<String> = HashSet::new();
    walk_md_in(root, "", exclude, &mut |rel, path| {
        seen.insert(rel.to_string());
        let Some(stamp) = file_stamp(path) else {
            return Ok(());
        };
        if index.files.get(rel).map(|old| *old == stamp).unwrap_or(false) {
            return Ok(());
        }
        // 不可读文件（非 UTF-8/权限）跳过，不中断整仓索引——与其他扫描路径行为一致
        let Ok(content) = std::fs::read_to_string(path) else {
            return Ok(());
        };
        index.files.insert(rel.to_string(), stamp);
        index.refs.insert(rel.to_string(), extract_refs(&content));
        Ok(())
    })?;
    index.files.retain(|rel, _| seen.contains(rel));
    index.refs.retain(|rel, _| seen.contains(rel));
    Ok(())
}

/// 查询反链：`[[name]]` 按笔记名精确匹配；`[label](path)` 按归一化后的完整路径或文件名（basename）匹配
/// （大小写不敏感兜底：Windows 文件系统不区分大小写）。
pub fn query_wiki_backlinks(index: &WikiIndex, note_name: &str, note_file: &str) -> Vec<BacklinkRow> {
    let target_basename = note_file.rsplit('/').next().unwrap_or(note_file);
    let mut rows: Vec<BacklinkRow> = Vec::new();
    for (rel, refs) in &index.refs {
        let hit = refs.iter().any(|r| {
            if let Some(name) = &r.name {
                name == note_name
            } else if let Some(path) = &r.path {
                if path == note_file || path.eq_ignore_ascii_case(note_file) {
                    return true;
                }
                let base = path.rsplit('/').next().unwrap_or(path.as_str());
                base == target_basename || base.eq_ignore_ascii_case(target_basename)
            } else {
                false
            }
        });
        if hit {
            let title = rel
                .rsplit('/')
                .next()
                .unwrap_or(rel)
                .trim_end_matches(".md")
                .to_string();
            rows.push(BacklinkRow {
                file: rel.clone(),
                title,
            });
        }
    }
    rows
}

/// 递归遍历仓库 .md（与文件树同过滤：跳过隐藏目录与用户排除文件夹）。
pub(crate) fn walk_md_in(
    root: &Path,
    rel: &str,
    exclude: &[String],
    f: &mut dyn FnMut(&str, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    if !dir.exists() {
        return Ok(());
    }
    for (child_rel, is_dir) in read_dir_filtered(&dir, rel, exclude)? {
        if is_dir {
            walk_md_in(root, &child_rel, exclude, f)?;
        } else if child_rel.ends_with(".md") {
            f(&child_rel, &root.join(&child_rel))?;
        }
    }
    Ok(())
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(FileStamp {
        mtime_ms,
        size: meta.len(),
    })
}

/// 提取引用：`[[target]]` / `[[target|别名]]` + `[label](path)`（回溯 `[` 检查前导 `!` 排除图片）。
fn extract_refs(content: &str) -> Vec<WikiRef> {
    let mut refs = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        match after.find("]]") {
            Some(end) => {
                let target = &after[..end];
                let name = target.split('|').next().unwrap_or(target).trim();
                if !name.is_empty() {
                    refs.push(WikiRef {
                        name: Some(name.to_string()),
                        path: None,
                    });
                }
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    let mut rest = content;
    while let Some(rel) = rest.find("](") {
        let before = &rest[..rel];
        let after = &rest[rel + 2..];
        let close = after.find(')').unwrap_or(after.len());
        let path = &after[..close];
        // 无前导 `[`（正文裸写 `](`）不是链接；回溯 `[` 检查前导 `!` 排除图片
        let Some(open) = before.rfind('[') else {
            rest = &after[close..];
            continue;
        };
        let is_image = open > 0 && before.as_bytes()[open - 1] == b'!';
        if !is_image {
            if let Some(normalized) = normalize_link_path(path) {
                refs.push(WikiRef {
                    name: None,
                    path: Some(normalized),
                });
            }
        }
        rest = &after[close..];
    }
    refs
}

/// 归一化链接路径：percent 解码、反斜杠→`/`、去 `./` 与前导 `/`；含 `..` 段返回 None（防越出仓库）。
fn normalize_link_path(raw: &str) -> Option<String> {
    let mut s = percent_decode(raw);
    s = s.replace('\\', "/");
    while let Some(stripped) = s.strip_prefix("./") {
        s = stripped.to_string();
    }
    while let Some(stripped) = s.strip_prefix('/') {
        s = stripped.to_string();
    }
    if s.is_empty() {
        return None;
    }
    for seg in s.split('/') {
        if seg == ".." {
            return None;
        }
    }
    Some(s)
}

/// 简易 percent 解码（%XX）；非法序列原样保留（匹配不上自然不命中，不报错）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ===== 内部链接跨度改写（重建工具 + 重命名/移动维护共用）=====
//
// 原则：字节级替换——只改写链接跨度，其余内容（含换行/空格/顺序）原样保留（文本即真相，不做
// AST 往返序列化，防整文档格式被重排）。改写范围规则：
// - 跳过 frontmatter（仅文档开头 `---` 块）、围栏代码块（``` / ~~~）、行内代码（反引号 run）、图片链接 `![..](..)`；
// - 链接跨度：`[[名]]` / `[[名|别名]]`（wiki 形式）与 `[label](path)`（标准形式）。

/// 若 `i` 处位于行首（i == 0 或前一字符为换行）。
fn at_line_start(content: &str, i: usize) -> bool {
    i == 0 || content.as_bytes()[i - 1] == b'\n'
}

/// `i` 处若为围栏行首（``` 或 ~~~，≥3 个同字符），返回围栏长度。
fn fence_len_at(content: &str, i: usize) -> Option<usize> {
    let ch = content[i..].chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let n = content[i..].chars().take_while(|&c| c == ch).count();
    if n >= 3 {
        Some(n)
    } else {
        None
    }
}

/// 在 `rest`（围栏开启后的剩余内容）中找行首同字符闭合围栏（≥ open_len，前导空格 ≤3），
/// 返回闭合围栏所在行的结束字节位置（含行尾换行）。
fn fence_close_end(rest: &str, open_char: char, open_len: usize) -> Option<usize> {
    let mut pos = 0usize;
    for line in rest.split_inclusive('\n') {
        let start = pos;
        pos += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']);
        let lead = trimmed.chars().take_while(|&c| c == ' ').count();
        if lead <= 3 {
            let body = &trimmed[lead..];
            let n = body.chars().take_while(|&c| c == open_char).count();
            if n >= open_len {
                return Some(start + line.len());
            }
        }
    }
    None
}

/// 文档开头 frontmatter 结束位置（`---\n ... ---\n` 闭合行之后）；无闭合返回 None。
fn frontmatter_end(content: &str) -> Option<usize> {
    let first_nl = content.find('\n')?;
    let mut pos = first_nl + 1;
    for line in content[first_nl + 1..].split_inclusive('\n') {
        let start = pos;
        pos += line.len();
        if line.trim_end_matches(['\n', '\r']) == "---" {
            return Some(start + line.len());
        }
    }
    None
}

/// 反引号 run 长度（i 处起连续反引号数）。
fn backtick_run_at(content: &str, i: usize) -> usize {
    content[i..].bytes().take_while(|&b| b == b'`').count()
}

/// 从 `from` 起找 ≥n 个连续反引号的闭合位置（run 之后）；无闭合返回 None。
fn backtick_close(content: &str, from: usize, n: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = backtick_run_at(content, i);
            if run >= n {
                return Some(i + run);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

/// 链接跨度改写引擎：跳过 frontmatter/围栏代码/缩进代码/原始 HTML/行内代码/图片链接，
/// 对每个链接跨度调用 `apply`（返回原样 = 不改）。仅用于字节级替换场景（重建/维护），不用于解析。
pub(crate) fn rewrite_link_spans(content: &str, apply: &mut dyn FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(content.len());
    let len = content.len();
    let mut i = 0;
    // 文档开头 frontmatter：整体跳过（YAML 里出现 `[[`/`](` 是数据不是链接）
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        if let Some(end) = frontmatter_end(content) {
            out.push_str(&content[..end]);
            i = end;
        }
    }
    while i < len {
        // 块级跳过（CommonMark 语义，防链接语法在代码/HTML 中被改写）：
        // - 缩进代码块（≥4 空格缩进行）；
        // - 原始 HTML：行首 `<`（标签块以空行结束；`<!--` 注释可跨行至 `-->`）
        if at_line_start(content, i) {
            let rest = &content[i..];
            let lead = rest.bytes().take_while(|&b| b == b' ').count();
            if lead >= 4 {
                let end = rest.find('\n').map_or(len, |p| i + p + 1);
                out.push_str(&content[i..end]);
                i = end;
                continue;
            }
            let after = &rest[lead..];
            let html_start = after.starts_with("<!--")
                || after.starts_with("<?")
                || after.starts_with("<!")
                || after.starts_with("</")
                || (after.starts_with('<')
                    && after.len() > 1
                    && after.as_bytes()[1].is_ascii_alphabetic());
            if html_start {
                if after.starts_with("<!--") {
                    // HTML 注释：可跨行，跳至 `-->`（未闭合则余下整体跳过）
                    let from = i + lead + 4;
                    let end = content[from..].find("-->").map_or(len, |p| from + p + 3);
                    out.push_str(&content[i..end]);
                    i = end;
                } else {
                    // 标签块：以空行结束，逐行跳过
                    let mut cursor = i;
                    loop {
                        match content[cursor..].find('\n') {
                            Some(p) => {
                                let line_end = cursor + p;
                                if content[cursor..line_end].trim().is_empty() {
                                    cursor = line_end;
                                    break;
                                }
                                cursor = line_end + 1;
                            }
                            None => {
                                cursor = len;
                                break;
                            }
                        }
                    }
                    out.push_str(&content[i..cursor]);
                    i = cursor;
                }
                continue;
            }
        }
        // 围栏代码块：行首 ``` / ~~~，跳至行首同字符闭合围栏
        if at_line_start(content, i) {
            if let Some(open_len) = fence_len_at(content, i) {
                let open_char = content[i..].chars().next().unwrap();
                if let Some(close) = fence_close_end(&content[i + open_len..], open_char, open_len) {
                    let end = i + open_len + close;
                    out.push_str(&content[i..end]);
                    i = end;
                    continue;
                }
            }
        }
        // 行内代码：反引号 run，跳至等长（或更长）run 闭合
        if content.as_bytes()[i] == b'`' {
            let n = backtick_run_at(content, i);
            if let Some(close) = backtick_close(content, i + n, n) {
                out.push_str(&content[i..close]);
                i = close;
                continue;
            }
        }
        // wiki 链接 `[[..]]`：前导非 `!`（`![[a]]` 为嵌入语法，不按链接改写，防转成图片语法）
        if content[i..].starts_with("[[") && (i == 0 || content.as_bytes()[i - 1] != b'!') {
            if let Some(end_rel) = content[i + 2..].find("]]") {
                let end = i + 2 + end_rel + 2;
                out.push_str(&apply(&content[i..end]));
                i = end;
                continue;
            }
        }
        // `[label](path)`：前导非 `!`（图片链接不处理）
        if content.as_bytes()[i] == b'[' && (i == 0 || content.as_bytes()[i - 1] != b'!') {
            if let Some(rel) = content[i + 1..].find(']') {
                let after_label = i + 1 + rel + 1;
                if content.as_bytes().get(after_label) == Some(&b'(') {
                    if let Some(rel2) = content[after_label + 1..].find(')') {
                        let end = after_label + 1 + rel2 + 1;
                        out.push_str(&apply(&content[i..end]));
                        i = end;
                        continue;
                    }
                }
            }
        }
        let ch_len = content[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&content[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// 取标准链接跨度 `[label](path)` 的 path 部分（wiki 形式 `[[..]]` 返回 None）。
pub(crate) fn markdown_link_path(span: &str) -> Option<&str> {
    if span.starts_with("[[") {
        return None;
    }
    let open = span.find("](")?;
    Some(&span[open + 2..span.len() - 1])
}

/// 收集需更新 markdown 内部链接的笔记（不写盘；事务模式与 collect_canvas_updates 同构）。
/// `apply`：对每个链接跨度返回替换结果（原样 = 不改）。返回 `(相对路径, 新内容)` 列表。
pub(crate) fn collect_md_link_updates(
    root: &Path,
    exclude: &[String],
    apply: &mut dyn FnMut(&str) -> String,
) -> Result<Vec<(String, String)>, String> {
    let mut updates: Vec<(String, String)> = vec![];
    walk_md_in(root, "", exclude, &mut |rel, path| {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return Ok(()), // 不可读跳过，不阻塞其余
        };
        let next = rewrite_link_spans(&content, apply);
        if next != content {
            updates.push((rel.to_string(), next));
        }
        Ok(())
    })?;
    Ok(updates)
}

/// 写回收集的 .md 更新（复用 write_note 原子写 + 路径校验）。
pub(crate) fn flush_md_updates(root: &Path, updates: &[(String, String)]) -> Result<(), String> {
    for (rel, content) in updates {
        write_note(root, rel, content)?;
    }
    Ok(())
}

/// 解析内部链接目标（笔记名或相对路径）→ 规范相对路径。
/// - 候选构造：`name` 已是 `.md` 路径（`[x](路径.md)` 形式）→ 原样作候选；否则按笔记名补 `.md` + 净化变体；
/// - 匹配顺序：精确路径 → 文件名命中 → **同名歧义取「路径最短（根目录优先）+ 字典序」确定性兜底**
///   （对齐前端 noteList 首个命中的可打开语义，防同名链接失效）；
/// - 全部分支后做大小写不敏感兜底：Windows 文件系统不区分大小写，`方案.MD` 与 `方案.md` 是同一文件。
pub(crate) fn resolve_link_target(
    name: &str,
    exact: &HashSet<String>,
    by_basename: &HashMap<String, Vec<String>>,
) -> Option<String> {
    let mut candidates: Vec<String> = if name.to_ascii_lowercase().ends_with(".md") {
        vec![name.to_string()]
    } else {
        vec![format!("{name}.md")]
    };
    if !name.to_ascii_lowercase().ends_with(".md") {
        let sanitized = sanitize_filename(name);
        if !sanitized.is_empty() && sanitized != name {
            candidates.push(format!("{sanitized}.md"));
        }
    }
    let pick = |rels: &Vec<String>| -> Option<String> {
        rels.iter()
            .min_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)))
            .cloned()
    };
    for cand in &candidates {
        if exact.contains(cand) {
            return Some(cand.clone());
        }
        if let Some(rels) = by_basename.get(cand) {
            if let Some(best) = pick(rels) {
                return Some(best);
            }
        }
    }
    for cand in &candidates {
        if let Some(hit) = exact.iter().find(|s| s.eq_ignore_ascii_case(cand)) {
            return Some(hit.clone());
        }
        if let Some((_, rels)) = by_basename.iter().find(|(k, _)| k.eq_ignore_ascii_case(cand)) {
            if let Some(best) = pick(rels) {
                return Some(best);
            }
        }
    }
    None
}

/// 一次性重建内部链接（设置 → 编辑器「重建内部链接」入口）：
/// - `[[名]]` / `[[名|别名]]` → `[名](规范相对路径)` / `[别名](规范相对路径)`；
/// - `[label](路径.md)` 命中仓库内 .md → 规范为 `[label](规范相对路径)`（解码 + 归一化）；
/// - `[名]()` 空路径 → 按 label 当笔记名解析，命中则补全为规范路径，仍不存在则保持空路径；
/// - 目标笔记不存在 → `[名]()`（空路径，点击可快捷新建）；
/// - 外部链接 / 非 .md 相对路径 / 图片链接 / 代码块内 → 一律不动（保守不猜）。
/// `resolve`：笔记名或路径 → 命中时的规范相对路径（None = 未命中）。返回 (新内容, 实际改写处数)。
pub(crate) fn rewrite_internal_links(
    content: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> (String, usize) {
    let mut count = 0usize;
    let out = rewrite_link_spans(content, &mut |span: &str| {
        let replaced: String;
        let is_wiki = span.starts_with("[[");
        let (label, target): (&str, Option<String>) = if is_wiki {
            let inner = &span[2..span.len() - 2];
            let (name, alias) = match inner.split_once('|') {
                Some((n, a)) => (n.trim(), a.trim()),
                None => (inner.trim(), ""),
            };
            let label = if alias.is_empty() { name } else { alias };
            (label, resolve(name))
        } else {
            let Some(path) = markdown_link_path(span) else {
                return span.to_string();
            };
            let label = &span[1..span.find("](").unwrap_or(1)];
            if path.is_empty() {
                // `[名]()`：按 label 当笔记名解析，命中则补全路径；仍不存在则保持空路径（点击快捷新建）
                if let Some(target) = resolve(label) {
                    count += 1;
                    return format!("[{label}]({target})");
                }
                return span.to_string();
            }
            let norm = normalize_link_path(path);
            if norm.is_none() {
                return span.to_string();
            }
            let resolved = resolve(norm.as_deref().unwrap());
            // 未命中但仍是 .md 形状（大小写不敏感，Windows 文件系统语义）→ 空路径（可快捷新建）；非 .md（附件等）不动
            if resolved.is_none() && !norm.as_deref().unwrap().to_ascii_lowercase().ends_with(".md")
            {
                return span.to_string();
            }
            (label, resolved)
        };
        replaced = match target {
            Some(p) => format!("[{label}]({p})"),
            None => format!("[{label}]()"),
        };
        if replaced != span {
            count += 1;
        }
        replaced
    });
    (out, count)
}

#[cfg(test)]
mod link_rewrite_tests {
    use super::*;

    /// 按命令层同款逻辑构造解析器（exact + by_basename → resolve_link_target）。
    fn resolver<'a>(files: &'a [&'a str]) -> impl Fn(&str) -> Option<String> + 'a {
        let exact: HashSet<String> = files.iter().map(|s| s.to_string()).collect();
        let mut by_basename: HashMap<String, Vec<String>> = HashMap::new();
        for rel in files {
            let base = rel.rsplit('/').next().unwrap_or(rel).to_string();
            by_basename.entry(base).or_default().push(rel.to_string());
        }
        move |name: &str| resolve_link_target(name, &exact, &by_basename)
    }

    #[test]
    fn wiki_link_root_note() {
        let resolve = resolver(&["note-a.md"]);
        let (out, n) = rewrite_internal_links("见 [[note-a]]", &resolve);
        assert_eq!(out, "见 [note-a](note-a.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn wiki_link_subfolder_unique() {
        let resolve = resolver(&["notes/note-b.md"]);
        let (out, n) = rewrite_internal_links("见 [[note-b]]", &resolve);
        assert_eq!(out, "见 [note-b](notes/note-b.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn wiki_link_alias_form() {
        let resolve = resolver(&["notes/note-b.md"]);
        let (out, n) = rewrite_internal_links("见 [[note-b|alias-b]]", &resolve);
        assert_eq!(out, "见 [alias-b](notes/note-b.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn path_link_exact_and_basename() {
        let resolve = resolver(&["notes/note-b.md"]);
        // 完整路径链接：已是规范形式，不做追加 .md 的候选处理，保持原样
        let (out, n) = rewrite_internal_links("[note-b](notes/note-b.md)", &resolve);
        assert_eq!(out, "[note-b](notes/note-b.md)");
        assert_eq!(n, 0);
        // 文件名形式链接：按 basename 命中并规范为完整路径
        let (out2, n2) = rewrite_internal_links("[note-b](note-b.md)", &resolve);
        assert_eq!(out2, "[note-b](notes/note-b.md)");
        assert_eq!(n2, 1);
    }

    #[test]
    fn path_link_encoded_normalized() {
        let resolve = resolver(&["topic a.md"]);
        let (out, n) = rewrite_internal_links("[doc](topic%20a.md)", &resolve);
        assert_eq!(out, "[doc](topic a.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn wiki_link_duplicate_basename_keeps_resolvable() {
        // 回归：同名多文件不得转空路径——根目录优先（路径最短），确定性兜底
        let resolve = resolver(&["note-b.md", "notes/note-b.md"]);
        let (out, n) = rewrite_internal_links("见 [[note-b]]", &resolve);
        assert_eq!(out, "见 [note-b](note-b.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn missing_note_becomes_empty() {
        let resolve = resolver(&[]);
        let (out, n) = rewrite_internal_links("见 [[missing-note]]", &resolve);
        assert_eq!(out, "见 [missing-note]()");
        assert_eq!(n, 1);
    }

    #[test]
    fn empty_link_recovered_by_label() {
        // `[名]()` 空路径链接按 label 解析命中 → 补全为规范路径
        let resolve = resolver(&["notes/note-b.md"]);
        let (out, n) = rewrite_internal_links("见 [note-b]()", &resolve);
        assert_eq!(out, "见 [note-b](notes/note-b.md)");
        assert_eq!(n, 1);
    }

    #[test]
    fn empty_link_kept_when_note_missing() {
        let resolve = resolver(&[]);
        let (out, n) = rewrite_internal_links("见 [note-b]()", &resolve);
        assert_eq!(out, "见 [note-b]()");
        assert_eq!(n, 0);
    }

    #[test]
    fn skips_code_block_inline_code_image_external() {
        let resolve = resolver(&["note-b.md"]);
        let content =
            "```\n[[note-b]]\n```\n\n`[[note-b]]`\n\n![img](note-b.md)\n\n[ext](https://example.com)\n\n[[note-b]]";
        let (out, n) = rewrite_internal_links(content, &resolve);
        assert_eq!(
            out,
            "```\n[[note-b]]\n```\n\n`[[note-b]]`\n\n![img](note-b.md)\n\n[ext](https://example.com)\n\n[note-b](note-b.md)"
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn embed_notation_skipped() {
        // `![[a]]` 是嵌入语法（前导 !），不按链接改写——防转成图片语法 `![a](a.md)`
        let resolve = resolver(&["note-b.md"]);
        let (out, n) = rewrite_internal_links("![[note-b]]", &resolve);
        assert_eq!(out, "![[note-b]]");
        assert_eq!(n, 0);
    }

    #[test]
    fn skips_indented_code_and_raw_html() {
        let resolve = resolver(&["note-b.md"]);
        let content =
            "    [[note-b]]\n    [x](note-b.md)\n\n<div>\n[[note-b]]\n</div>\n\n<!--\n[[note-b]]\n-->\n\n见 [[note-b]]";
        let (out, n) = rewrite_internal_links(content, &resolve);
        assert_eq!(
            out,
            "    [[note-b]]\n    [x](note-b.md)\n\n<div>\n[[note-b]]\n</div>\n\n<!--\n[[note-b]]\n-->\n\n见 [note-b](note-b.md)"
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn case_insensitive_resolution() {
        // Windows 文件系统不区分大小写：`note-b.MD` 与 `note-b.md` 是同一文件
        let resolve = resolver(&["notes/note-b.md"]);
        let (out, n) = rewrite_internal_links("[x](note-b.MD)", &resolve);
        assert_eq!(out, "[x](notes/note-b.md)");
        assert_eq!(n, 1);
        let (out2, n2) = rewrite_internal_links("[[note-b]]", &resolve);
        assert_eq!(out2, "[note-b](notes/note-b.md)");
        assert_eq!(n2, 1);
    }

    #[test]
    fn frontmatter_skipped() {
        let resolve = resolver(&["note-b.md"]);
        let content = "---\ntags: [[note-b]]\n---\n\n见 [[note-b]]";
        let (out, _) = rewrite_internal_links(content, &resolve);
        assert_eq!(out, "---\ntags: [[note-b]]\n---\n\n见 [note-b](note-b.md)");
    }
}
