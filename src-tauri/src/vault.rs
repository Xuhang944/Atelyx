//! 仓库文件读写核心模块。
//!
//! 仓库 = 用户自选文件夹，无数据库，全部文件存储。
//! 文件结构与 .atlx schema 。
//! 本模块只做文件 I/O + 路径校验，不耦合业务语义（text 节点 bodyMd
//! 的剥离/填充在 services/vault 层组合）。

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

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

/// 当前仓库会话状态，由 lib.rs app.manage 注入，命令通过 State<VaultState> 读取。
pub struct VaultState(pub Mutex<Option<VaultSession>>);

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
        Self(Mutex::new(None))
    }
}

impl VaultState {
    /// 取当前仓库根路径，未打开仓库时返回错误。
    pub fn root(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.root.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 取当前仓库生效的排除文件夹列表（缺省 = 空），未打开仓库时返回错误。
    pub fn exclude_folders(&self) -> Result<Vec<String>, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.exclude_folders.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 取当前仓库生效的附件导入文件夹（None = 仓库根目录），未打开仓库时返回错误。
    pub fn attachment_folder(&self) -> Result<Option<String>, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|s| s.attachment_folder.clone())
            .ok_or_else(|| "未打开仓库".to_string())
    }

    /// 设置当前仓库会话（canonicalize 消除 `..`/符号链接，保证 safe_join 校验与 watcher 语义一致；
    /// 用 dunce 去除 Windows `\\?\` 长路径前缀，保证存/回传给前端的路径格式统一）。
    /// 返回 Result：Mutex poisoned 时向上传播而非静默丢弃（与 root() 策略一致）。
    pub fn set(
        &self,
        root: PathBuf,
        exclude_folders: Vec<String>,
        attachment_folder: Option<String>,
    ) -> Result<(), String> {
        let canonical = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let mut guard = self.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(VaultSession {
            root: canonical,
            exclude_folders,
            attachment_folder,
        });
        Ok(())
    }
}

// ===== .atlx 文件结构（对应前端 types/canvas.ts）=====
// data 用 serde_json::Value，不耦合业务字段；rename_all = "camelCase" 对齐前端。

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
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
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
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
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir && path.extension().and_then(|s| s.to_str()) == Some("tmp") {
            // 跳过 atomic_write 的 `.tmp` 中间文件（vault.rs 原子写 `path.tmp` → rename 副产物）
            continue;
        }
        let mtime = entry
            .metadata()
            .map_err(|e| e.to_string())?
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let children = if is_dir {
            list_tree_in(root, &child_rel, exclude)?
        } else {
            vec![]
        };
        nodes.push(FileTreeNode {
            name,
            path: child_rel,
            is_dir,
            updated_at: mtime,
            children,
        });
    }
    nodes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(nodes)
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
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
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
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            scan_canvases_in(root, &child_rel, exclude, rows)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("atlx") {
            // 完整解析取 id/title/updatedAt（.atlx 文件不大，无需流式）
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
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TableRow {
    pub id: String,
    /// 单元格值按字段 id 存（缺 key = 空单元格）。
    #[serde(default)]
    pub values: serde_json::Map<String, serde_json::Value>,
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
    /// 仓库级主题："light" | "dark"。缺失时前端默认 "dark"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_explorer_sort: Option<String>,
    /// 仓库级界面基础字号（px，与前端 VaultConfig.fontSize 对齐；缺字段会丢设置）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    /// 仓库级界面字体（CSS font-family，与前端 VaultConfig.fontFamily 对齐）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
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
    /// 进入仓库时自动恢复上次打开的文件。缺省 = true（前端默认）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_restore_files: Option<bool>,
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

// ===== 仓库级 UI 使用状态（.atelyx/ui-state.json，）=====
// 与仓库级配置（config.json）分离：本文件保存「使用数据」（文件面板展开情况、
// 上次打开的文件），高频展开/折叠写入抖动不进配置；文件在 .atelyx 隐藏目录内，
// watcher 天然过滤、无自写回环（与 prompt-notes.json / editor-chats.json 同策略）。

/// ui-state.json 的 schema 版本（与前端 types/uiState.ts 的 UI_STATE_SCHEMA 对齐）。
pub const UI_STATE_SCHEMA: &str = "atelyx-ui-state/v1";

/// 单设备的仓库级 UI 使用状态（`VaultUiState.per_device` 的一个条目）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUiState {
    /// 文件面板展开的文件夹相对路径列表（缺省 = 全部折叠）。
    #[serde(default)]
    pub file_explorer_expanded: Vec<String>,
    /// 上次打开的画布文件（相对仓库根路径；关闭/删除后清空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_canvas_file: Option<String>,
    /// 上次打开的笔记文件（相对仓库根路径；关闭/删除后清空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_file: Option<String>,
    /// 上次打开的表格文件（相对仓库根路径；关闭/删除后清空）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_table_file: Option<String>,
    /// 上次激活的窗口（"canvas" | "note" | "table"；缺省 = 画布槽）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_window: Option<String>,
}

/// 仓库级 UI 使用状态（缺省 = 空：展开空、无上次打开文件）。
/// 按设备分桶（`per_device`，key = 本设备 ID，见 `commands/global.rs` 的 `device_id`）：
/// 仓库可能随 Git/云盘多设备同步，平铺单值会被他设备覆盖——各设备读写自己的桶。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultUiState {
    pub schema: String,
    /// 各设备的 UI 状态（key = 设备 ID；缺省 = 该设备无条目，回退旧平铺字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_device: Option<std::collections::HashMap<String, DeviceUiState>>,
    // 旧平铺字段：仅兼容读取迁移（本设备首次写入后不再落盘），新写入只写 per_device。
    /// 文件面板展开的文件夹相对路径列表（旧格式，见 per_device）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_explorer_expanded: Option<Vec<String>>,
    /// 上次打开的画布文件（旧格式，见 per_device）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_canvas_file: Option<String>,
    /// 上次打开的笔记文件（旧格式，见 per_device）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_file: Option<String>,
    /// 上次打开的表格文件（旧格式，见 per_device）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_table_file: Option<String>,
    /// 上次激活的窗口（旧格式，见 per_device）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_window: Option<String>,
}

/// 读仓库级 UI 状态（不存在返回默认；解析失败降级为默认——手编辑损坏只影响恢复，不阻塞仓库打开）。
pub fn read_ui_state_file(root: &Path) -> Result<VaultUiState, String> {
    let path = root.join(".atelyx").join("ui-state.json");
    if !path.exists() {
        return Ok(VaultUiState::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let state = serde_json::from_str::<VaultUiState>(&json).unwrap_or_default();
    // schema 校验：不符即拒绝（同 .atlx/editor-chats 私有格式保护，防外部工具/手改误写）
    if state.schema != UI_STATE_SCHEMA {
        return Ok(VaultUiState::default());
    }
    Ok(state)
}

/// 写仓库级 UI 状态（原子写 .atelyx/ui-state.json）。
pub fn write_ui_state_file(root: &Path, state: &VaultUiState) -> Result<(), String> {
    let path = root.join(".atelyx").join("ui-state.json");
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== AI 对话面板会话（.atelyx/editor-chats.json，）=====
// 单一全局历史：全部会话扁平存放，不按笔记归属；不含 API key（key 只进全局 keychain）。
// 该文件不在 watcher 监听范围（watcher 只监听 画布/笔记/附件 三目录），自写无回环问题。

/// editor-chats.json 的 schema 版本（与前端 types/chat.ts 的 EDITOR_CHATS_SCHEMA 对齐）。
pub const EDITOR_CHATS_SCHEMA: &str = "atelyx-editor-chats/v2";

/// 会话消息正文 .md 目录（相对仓库根；位于 `.atelyx/` 下——watcher 不监听、文件面板不显示，无自写回环）。
pub const CHAT_HISTORY_DIR: &str = ".atelyx/对话历史";

/// 面板消息（纯文本对话，无 attachments/refs）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorChatMessage {
    pub id: String,
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// user 消息气泡显示用：发送时的原始输入，与 content 分离（content 可能含注入的笔记全文）。
    /// 缺字段 = 旧文件兼容（气泡回退显示 content）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_content: Option<String>,
    pub created_at: i64,
}

/// 单个会话（首条 user 消息前缀作标题，历史列表展示）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorChatSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 系统提示词笔记引用（文件面板右键「注册为提示词」标记的笔记可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_file: Option<String>,
    /// 已注入上下文的笔记（防重复注入：同一笔记只注入一次，更换笔记才再次注入；仅会话运行期内有效，不落盘）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injected_note_file: Option<String>,
    /// v1 兼容：消息正文内嵌（v2 迁移后为空，正文在消息 .md；空列表不写出）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<EditorChatMessage>,
    /// v2：消息正文 .md 相对仓库根路径（`.atelyx/对话历史/<标题>.md`）
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
}

/// 读 AI 对话面板会话文件（不存在/解析失败返回默认——手编辑损坏不阻塞面板）。
pub fn read_editor_chats_file(root: &Path) -> Result<EditorChatsFile, String> {
    let path = root.join(".atelyx").join("editor-chats.json");
    if !path.exists() {
        return Ok(EditorChatsFile::default());
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file = serde_json::from_str::<EditorChatsFile>(&json).unwrap_or_default();
    // schema 校验：v1/v2 均接受——v1 存量由前端 load 检测后迁移（导出消息 .md）并写回 v2 索引
    if !matches!(file.schema.as_str(), EDITOR_CHATS_SCHEMA | "atelyx-editor-chats/v1") {
        return Err(format!("会话文件 schema 不匹配：{}", file.schema));
    }
    Ok(file)
}

/// 写 AI 对话面板会话文件（原子写 .atelyx/editor-chats.json）。
pub fn write_editor_chats_file(root: &Path, file: &EditorChatsFile) -> Result<(), String> {
    let path = root.join(".atelyx").join("editor-chats.json");
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    atomic_write(&path, &json)
}

// ===== 会话消息正文（.atelyx/对话历史/*.md）=====

/// 校验并定位会话消息正文路径：必须位于 `.atelyx/对话历史/` 下且以 .md 结尾（防越权读写任意文件）。
fn chat_messages_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    let prefix = format!("{}/", CHAT_HISTORY_DIR);
    if !file.starts_with(&prefix) || !file.ends_with(".md") {
        return Err(format!("非法会话消息路径：{}", file));
    }
    safe_join(root, file, false)
}

/// 读会话消息正文 .md（文件不存在报错，由前端 catch 降级为空消息）。
pub fn read_chat_messages_file(root: &Path, file: &str) -> Result<String, String> {
    let path = chat_messages_path(root, file)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 写会话消息正文 .md（自动建 `.atelyx/对话历史/` 目录 + 原子写）。
pub fn write_chat_messages_file(root: &Path, file: &str, content: &str) -> Result<(), String> {
    std::fs::create_dir_all(root.join(CHAT_HISTORY_DIR)).map_err(|e| e.to_string())?;
    let path = chat_messages_path(root, file)?;
    atomic_write(&path, content)
}

/// 删会话消息正文 .md（不存在视为成功——幂等，删除会话时调用）。
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
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
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
