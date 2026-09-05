//! 插件平台命令：安装/卸载/启用/更新/读取入口与插件数据。
//!
//! 存储布局：
//! - app 级插件：`app_data_dir/plugins/<id>/`（个人工具，本机）
//! - vault 级插件：`<仓库根>/.atelyx/plugins/<id>/`（随仓库共享）
//! - 状态：`app_data_dir/plugin-state.json`（enabled 开关 + 安装来源 repo/scope）
//!
//! 安装流：解析 GitHub Release → 下载 zip →（有 digest 则 sha256 校验）→ 解压到临时目录
//! （防路径穿越/zip 炸弹）→ 校验 `atelyx.json` → 原子改名到目标目录；失败不留脏。
//!
//! 安全：插件 id 视为不可信输入，所有路径访问都经 `safe_join_plugin` 限制在对应插件根目录内
//! （防穿越越权）；插件代码在 WebView 隔离上下文执行、只能调前端桥（本模块只读入口 JS 与插件数据）。

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::vault::{atomic_write, VaultState};

/// 插件清单文件名（zip 内与插件根目录）。与前端 `constants/plugins.ts` 的 `PLUGIN_MANIFEST_FILE` 一致。
const MANIFEST_FILE: &str = "atelyx.json";
/// 状态文件名（app_data_dir 下）。
const STATE_FILE: &str = "plugin-state.json";

/// 下载与解压体积上限（zip 炸弹防御）。
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
/// 单条目解压体积上限。
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
/// zip 条目数上限。
const MAX_ENTRY_COUNT: usize = 10_000;
/// 入口 JS 读取字节上限。
const MAX_ENTRY_JS_BYTES: u64 = 2 * 1024 * 1024;

/// 插件 id 合法性（与前端 `pluginIdValid` 一致：反向域名式至少两段，无路径分隔符）。
fn plugin_id_valid(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 || id.contains(['/', '\\']) {
        return false;
    }
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty()
            && !seg.starts_with('-')
            && !seg.ends_with('-')
            && seg.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

/// 插件运行信息（返回前端）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub scope: String,
    pub install_dir: String,
    pub enabled: bool,
    pub manifest: Value,
}

/// 安装来源记录（更新时据此重新解析 Release）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginSource {
    repo: String,
    scope: String,
}

/// 插件平台状态（app_data_dir/plugin-state.json）。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PluginState {
    #[serde(default)]
    enabled: HashMap<String, bool>,
    #[serde(default)]
    sources: HashMap<String, PluginSource>,
}

fn plugin_base_dir(app: &AppHandle, state: &VaultState, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "app" => {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            Ok(dir.join("plugins"))
        }
        "vault" => {
            let root = state.root()?;
            Ok(root.join(".atelyx/plugins"))
        }
        other => Err(format!("未知插件作用域：{other}")),
    }
}

/// 插件根目录（作用域目录下按 id 定位，id 不可信故严格校验）。
fn plugin_dir(app: &AppHandle, state: &VaultState, scope: &str, id: &str) -> Result<PathBuf, String> {
    if !plugin_id_valid(id) {
        return Err("非法插件 id".to_string());
    }
    Ok(plugin_base_dir(app, state, scope)?.join(id))
}

/// 把插件目录内相对路径安全地拼接到插件根（防穿越越权）。
fn safe_join_plugin(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("非法插件内路径：{relative}"));
    }
    Ok(base.join(rel))
}

// ===== 状态文件 =====

fn plugin_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(STATE_FILE))
}

fn read_plugin_state(app: &AppHandle) -> PluginState {
    let Ok(path) = plugin_state_path(app) else {
        return PluginState::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_plugin_state(app: &AppHandle, state: &PluginState) -> Result<(), String> {
    let path = plugin_state_path(app)?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    // 复用 vault::atomic_write：唯一临时名 + fsync + 失败清理（全项目同一 durability 语义）。
    atomic_write(&path, &raw)
}

// ===== 清单校验 =====

/// 最小清单校验（结构错误拒绝；字段枚举与前端 `validatePluginManifest` 对齐）。
fn manifest_valid_or_error(v: &Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("清单必须是对象")?;
    let req = |k: &str| -> Result<String, String> {
        obj.get(k)
            .and_then(|x| x.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("清单缺少字段：{k}"))
    };
    let schema = obj
        .get("schemaVersion")
        .and_then(|x| x.as_i64())
        .filter(|n| *n > 0)
        .ok_or("schemaVersion 必须是正整数")?;
    if schema > 1 {
        return Err(format!("清单格式版本过新（{schema}），需要更新 Atelyx"));
    }
    let id = req("id")?;
    if !plugin_id_valid(&id) {
        return Err("id 必须是合法的反向域名标识".to_string());
    }
    req("name")?;
    req("version")?;
    let kind = req("type")?;
    // main 仅在纯 theme 插件（无任何代码承载类型）时可省略——theme 是声明式皮肤，无入口。
    // 判定与前端一致：只按「已知类型」归一化（未知附加分类安全跳过，前向兼容）——
    // 混入 tool 等已知代码类型才必填 main；types 非数组按畸形拒绝（与前端校验对齐）。
    let raw_types = obj.get("types");
    if raw_types.is_some() && !raw_types.and_then(|t| t.as_array()).is_some() {
        return Err("types 必须是数组".to_string());
    }
    let theme_only = kind == "theme"
        && raw_types
            .and_then(|t| t.as_array())
            .map_or(true, |arr| {
                arr.iter()
                    .filter_map(|t| t.as_str())
                    .filter(|t| is_known_plugin_type(t))
                    .all(|t| t == "theme")
            });
    if !theme_only {
        req("main")?;
    }
    Ok(())
}

/// 已知插件类型（与前端 PluginType 联合一致；未知类型前向兼容跳过）。
fn is_known_plugin_type(t: &str) -> bool {
    matches!(
        t,
        "tool" | "setting" | "panel" | "app" | "node" | "theme" | "command" | "background" | "tableview"
    )
}

/// 读取插件根目录的清单。
fn read_manifest(plugin_root: &Path) -> Result<Value, String> {
    let path = safe_join_plugin(plugin_root, MANIFEST_FILE)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取清单失败：{e}"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("清单不是合法 JSON：{e}"))?;
    manifest_valid_or_error(&v)?;
    Ok(v)
}

// ===== sha256 =====

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ===== GitHub Release 解析与下载 =====

/// 解析仓库最新 Release 的 zip 资产，返回 (下载地址, 可选 sha256 digest)。
async fn resolve_release_asset(repo: &str) -> Result<(String, Option<String>), String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "atelyx")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("解析 Release 失败：{e}"))?;
    if !resp.status().is_success() {
        let msg = match resp.status().as_u16() {
            404 => "仓库或 Release 不存在".to_string(),
            403 | 429 => "GitHub 限流，请稍后重试".to_string(),
            code => format!("HTTP {code}"),
        };
        return Err(format!("解析 Release 失败（{repo}）：{msg}"));
    }
    let body: Value = resp.json().await.map_err(|e| format!("解析 Release 响应失败：{e}"))?;
    let assets = body.get("assets").and_then(|a| a.as_array()).ok_or("Release 无资产列表")?;
    for asset in assets {
        let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name.ends_with(".zip") {
            let url = asset
                .get("browser_download_url")
                .and_then(|u| u.as_str())
                .ok_or("资产无下载地址")?
                .to_string();
            // GitHub 资产 digest 形如 "sha256:<hex>"；无 digest 时不做校验（源仓库即信任根）。
            let digest = asset
                .get("digest")
                .and_then(|d| d.as_str())
                .map(|s| s.strip_prefix("sha256:").unwrap_or(s).to_lowercase());
            return Ok((url, digest));
        }
    }
    Err("Release 无 zip 资产".into())
}

/// 下载 zip 到临时文件（体积上限校验）。
async fn download_zip(client: &reqwest::Client, url: &str, temp: &Path) -> Result<(), String> {
    let resp = client
        .get(url)
        .header("User-Agent", "atelyx")
        .send()
        .await
        .map_err(|e| format!("下载插件失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载插件失败（HTTP {}）", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("下载插件失败：{e}"))?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("插件包超过体积上限".into());
    }
    fs::write(temp, &bytes).map_err(|e| e.to_string())
}

// ===== zip 解压 =====

/// 净化 zip 条目路径：`/` 与 `\` 都按分隔符处理（防 Unix 下反斜杠文件名绕过穿越检查），
/// 拒绝 `..`、绝对路径、盘符前缀。
fn sanitize_zip_entry(name: &str) -> Result<String, String> {
    if name.starts_with('/') || name.starts_with('\\') {
        return Err("zip 条目含绝对路径".into());
    }
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return Err("zip 条目含 .. 路径".into()),
            other => {
                if other.contains(':') {
                    return Err("zip 条目含非法路径段".into());
                }
                out.push(other);
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("zip 条目路径为空".into());
    }
    Ok(out.to_string_lossy().into_owned())
}

/// 解压 zip 到目标目录（防路径穿越/zip 炸弹）。
fn extract_zip_safe(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("打开插件包失败：{e}"))?;
    if archive.len() > MAX_ENTRY_COUNT {
        return Err("插件包条目过多".into());
    }
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取插件包失败：{e}"))?;
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!("插件包条目过大：{}", entry.name()));
        }
        let clean = sanitize_zip_entry(entry.name())?;
        let target = dest.join(&clean);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut writer = fs::File::create(&target).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 解压后定位插件根：清单在临时目录根，或位于唯一顶层子目录（归档常见形态）。
fn locate_plugin_root(extract_dir: &Path) -> Result<PathBuf, String> {
    if extract_dir.join(MANIFEST_FILE).exists() {
        return Ok(extract_dir.to_path_buf());
    }
    let entries: Vec<PathBuf> = fs::read_dir(extract_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    let dirs: Vec<PathBuf> = entries.iter().filter(|p| p.is_dir()).cloned().collect();
    if entries.len() == 1 && dirs.len() == 1 && dirs[0].join(MANIFEST_FILE).exists() {
        return Ok(dirs[0].clone());
    }
    Err("插件包缺少 atelyx.json".into())
}

// ===== 安装 / 卸载 / 更新 =====

/// 从已下载 zip 执行校验 + 落位（提取到临时目录 → 校验清单 → 原子改名到目标插件目录）。
async fn install_zip(
    app: &AppHandle,
    state: &VaultState,
    scope: &str,
    repo: &str,
    zip_temp: &Path,
) -> Result<PluginInfo, String> {
    let base = plugin_base_dir(app, state, scope)?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // 临时解压目录（原子改名前驻留；失败清理）。
    let extract_temp = base.join(format!(".install-{}", nanoid()));
    let created = fs::create_dir_all(&extract_temp);
    if let Err(e) = created {
        let _ = fs::remove_dir_all(&extract_temp);
        return Err(format!("创建临时目录失败：{e}"));
    }
    let cleanup = || {
        let _ = fs::remove_dir_all(&extract_temp);
    };

    if let Err(e) = extract_zip_safe(zip_temp, &extract_temp) {
        cleanup();
        return Err(e);
    }
    let plugin_root = match locate_plugin_root(&extract_temp) {
        Ok(r) => r,
        Err(e) => {
            cleanup();
            return Err(e);
        }
    };
    let manifest = match read_manifest(&plugin_root) {
        Ok(m) => m,
        Err(e) => {
            cleanup();
            return Err(e);
        }
    };
    let id = manifest["id"].as_str().unwrap_or("").to_string();
    let name = manifest["name"].as_str().unwrap_or("").to_string();
    let version = manifest["version"].as_str().unwrap_or("").to_string();
    let kind = manifest["type"].as_str().unwrap_or("").to_string();

    // 目标目录已存在（重复安装）时先清掉，保证本次安装即当前版本。
    let target = plugin_dir(app, state, scope, &id)?;
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("清理旧版本失败：{e}"))?;
    }
    // 原子落位：先改名到目标，再清理临时目录。
    let move_result = fs::rename(&plugin_root, &target);
    cleanup();
    move_result.map_err(|e| format!("安装失败：{e}"))?;

    // 记录安装来源（更新依据）。
    let mut pstate = read_plugin_state(app);
    pstate.sources.insert(
        id.clone(),
        PluginSource {
            repo: repo.to_string(),
            scope: scope.to_string(),
        },
    );
    write_plugin_state(app, &pstate)?;

    let enabled = read_plugin_state(app).enabled.get(&id).copied().unwrap_or(false);
    Ok(PluginInfo {
        id,
        name,
        version,
        kind,
        scope: scope.to_string(),
        install_dir: target.to_string_lossy().into_owned(),
        enabled,
        manifest,
    })
}

/// 生成本地唯一后缀（防并发安装撞临时目录名）。
fn nanoid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

// ===== 命令 =====

/// 列出全部已装插件（app 级恒有；vault 级仅当前仓库；未开仓库时跳过 vault 目录）。
#[tauri::command]
pub fn plugin_list(app: AppHandle, state: State<'_, VaultState>) -> Result<Vec<PluginInfo>, String> {
    let pstate = read_plugin_state(&app);
    let mut out: Vec<PluginInfo> = Vec::new();

    let mut scan = |scope: &str, base: &Path| {
        let Ok(rd) = fs::read_dir(base) else {
            return;
        };
        for entry in rd.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let id = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if !plugin_id_valid(&id) {
                continue;
            }
            let Ok(manifest) = read_manifest(&dir) else {
                continue; // 损坏插件跳过展示（管理 UI 仍可整体删除目录）
            };
            let enabled = pstate.enabled.get(&id).copied().unwrap_or(false);
            out.push(PluginInfo {
                id,
                name: manifest["name"].as_str().unwrap_or("").to_string(),
                version: manifest["version"].as_str().unwrap_or("").to_string(),
                kind: manifest["type"].as_str().unwrap_or("").to_string(),
                scope: scope.to_string(),
                install_dir: dir.to_string_lossy().into_owned(),
                enabled,
                manifest,
            });
        }
    };

    if let Ok(base) = plugin_base_dir(&app, &state, "app") {
        scan("app", &base);
    }
    if let Ok(root) = state.root() {
        let base = root.join(".atelyx/plugins");
        scan("vault", &base);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// 从 GitHub 仓库安装插件（下载 → 校验 → 原子落位；安装后默认未启用，由前端确认后启用）。
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    state: State<'_, VaultState>,
    repo: String,
    scope: String,
) -> Result<PluginInfo, String> {
    // repo 只做网络请求参数；id 以清单为准。
    let (url, digest) = resolve_release_asset(&repo).await?;
    let client = reqwest::Client::new();
    let base = plugin_base_dir(&app, &state, &scope)?;
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let zip_temp = base.join(format!(".download-{}.zip", nanoid()));
    let download = download_zip(&client, &url, &zip_temp).await;
    if let Err(e) = download {
        let _ = fs::remove_file(&zip_temp);
        return Err(e);
    }
    if let Some(expected) = digest {
        let data = fs::read(&zip_temp).map_err(|e| e.to_string())?;
        let actual = sha256_hex(&data);
        if actual != expected {
            let _ = fs::remove_file(&zip_temp);
            return Err("插件包校验失败（sha256 不匹配）".into());
        }
    }
    let result = install_zip(&app, &state, &scope, &repo, &zip_temp).await;
    let _ = fs::remove_file(&zip_temp);
    result
}

/// 卸载插件（删除插件目录 + 清理状态记录）。
#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, state: State<'_, VaultState>, id: String, scope: String) -> Result<(), String> {
    let dir = plugin_dir(&app, &state, &scope, &id)?;
    if !dir.exists() {
        return Err("插件不存在".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("卸载失败：{e}"))?;
    let mut pstate = read_plugin_state(&app);
    pstate.enabled.remove(&id);
    pstate.sources.remove(&id);
    write_plugin_state(&app, &pstate)
}

/// 启用/停用插件（前端先确认权限再启用；vault 级插件卸载/禁用不清仓库内文件）。
#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut pstate = read_plugin_state(&app);
    if enabled {
        pstate.enabled.insert(id.clone(), true);
    } else {
        pstate.enabled.remove(&id);
    }
    write_plugin_state(&app, &pstate)
}

/// 更新插件：备份旧版 → 安装新版 → 失败回滚。
#[tauri::command]
pub async fn plugin_update(
    app: AppHandle,
    state: State<'_, VaultState>,
    id: String,
) -> Result<PluginInfo, String> {
    let pstate = read_plugin_state(&app);
    let source = pstate
        .sources
        .get(&id)
        .cloned()
        .ok_or("插件无安装来源，无法更新（请先卸载重装）")?;
    let scope = source.scope.clone();
    let base = plugin_base_dir(&app, &state, &scope)?;
    let dir = plugin_dir(&app, &state, &scope, &id)?;
    if !dir.exists() {
        return Err("插件不存在".into());
    }

    let (url, digest) = resolve_release_asset(&source.repo).await?;
    let client = reqwest::Client::new();
    let zip_temp = base.join(format!(".update-{}.zip", nanoid()));
    if let Err(e) = download_zip(&client, &url, &zip_temp).await {
        let _ = fs::remove_file(&zip_temp);
        return Err(e);
    }
    if let Some(expected) = digest {
        let data = fs::read(&zip_temp).map_err(|e| e.to_string())?;
        if sha256_hex(&data) != expected {
            let _ = fs::remove_file(&zip_temp);
            return Err("插件包校验失败（sha256 不匹配）".into());
        }
    }

    // 备份旧版 → 安装新版；任一失败回滚旧版。
    let backup = base.join(format!(".bak-{}-{}", id, nanoid()));
    let moved_backup = fs::rename(&dir, &backup);
    if let Err(e) = moved_backup {
        let _ = fs::remove_file(&zip_temp);
        return Err(format!("备份旧版失败：{e}"));
    }
    let install = install_zip(&app, &state, &scope, &source.repo, &zip_temp).await;
    let _ = fs::remove_file(&zip_temp);
    match install {
        Ok(info) => {
            let _ = fs::remove_dir_all(&backup);
            Ok(info)
        }
        Err(e) => {
            // 回滚：清掉可能的部分安装，恢复备份。
            if let Ok(b) = plugin_dir(&app, &state, &scope, &id) {
                let _ = fs::remove_dir_all(&b);
            }
            let _ = fs::rename(&backup, &dir);
            Err(format!("更新失败已回滚：{e}"))
        }
    }
}

/// 定位插件目录：优先按状态里的安装来源（scope），缺失时回退扫描两作用域按 id 定位
/// （vault 级插件随仓库同步到新机器时 sources 记录在本机不存在，仍应可读可运行）。
fn resolve_plugin_dir(app: &AppHandle, state: &VaultState, id: &str) -> Result<(PathBuf, String), String> {
    if plugin_id_valid(id) {
        if let Some(src) = read_plugin_state(app).sources.get(id) {
            if let Ok(dir) = plugin_dir(app, state, &src.scope, id) {
                if dir.is_dir() {
                    return Ok((dir, src.scope.clone()));
                }
            }
        }
        for scope in ["app", "vault"] {
            if let Ok(base) = plugin_base_dir(app, state, scope) {
                let dir = base.join(id);
                if dir.is_dir() {
                    return Ok((dir, scope.to_string()));
                }
            }
        }
    }
    Err("插件不存在".to_string())
}

/// 读取插件入口 JS（供隔离上下文加载；限制在插件根目录内）。path 缺省 = 清单 main。
#[tauri::command]
pub fn plugin_read_entry(
    app: AppHandle,
    state: State<'_, VaultState>,
    id: String,
    path: Option<String>,
) -> Result<String, String> {
    let (dir, _scope) = resolve_plugin_dir(&app, &state, &id)?;
    let manifest = read_manifest(&dir)?;
    let main = manifest["main"].as_str().ok_or("清单缺少 main")?;
    let entry = path.as_deref().unwrap_or(main);
    let entry_path = safe_join_plugin(&dir, entry)?;
    let data = fs::read(&entry_path).map_err(|e| format!("读取插件入口失败：{e}"))?;
    if data.len() as u64 > MAX_ENTRY_JS_BYTES {
        return Err("插件入口文件过大".into());
    }
    String::from_utf8(data).map_err(|_| "插件入口不是合法 UTF-8 文本".to_string())
}

/// 读取插件自持数据（单 JSON 对象，桥 state:persist 落盘）。
#[tauri::command]
pub fn plugin_read_state(app: AppHandle, state: State<'_, VaultState>, id: String) -> Result<Value, String> {
    let (dir, _scope) = resolve_plugin_dir(&app, &state, &id)?;
    let path = safe_join_plugin(&dir, "data/state.json")?;
    let raw = fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&raw).map_err(|e| format!("插件数据损坏：{e}"))
}

/// 写入插件自持数据（原子写；vault 级插件的随仓库共享）。
#[tauri::command]
pub fn plugin_write_state(app: AppHandle, state: State<'_, VaultState>, id: String, data: Value) -> Result<(), String> {
    let (dir, _scope) = resolve_plugin_dir(&app, &state, &id)?;
    let data_dir = safe_join_plugin(&dir, "data")?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("state.json");
    let raw = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    atomic_write(&path, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_validity() {
        assert!(plugin_id_valid("com.example.todo"));
        assert!(!plugin_id_valid("todo"));
        assert!(!plugin_id_valid("com/example"));
        assert!(!plugin_id_valid(".."));
        assert!(!plugin_id_valid("COM.Example"));
    }

    #[test]
    fn zip_path_sanitize() {
        // 平台无关断言：`/` 与 `\` 都是分隔符。
        let expected = Path::new("a").join("b").join("atelyx.json");
        let got = sanitize_zip_entry("a/b/atelyx.json").unwrap();
        assert_eq!(Path::new(&got), expected);
        assert_eq!(sanitize_zip_entry("./atelyx.json").unwrap(), "atelyx.json");
        assert!(sanitize_zip_entry("a\\b").is_ok());
        assert!(sanitize_zip_entry("../evil").is_err());
        assert!(sanitize_zip_entry("a\\..\\b").is_err());
        assert!(sanitize_zip_entry("/abs").is_err());
        assert!(sanitize_zip_entry("C:/x").is_err());
        assert!(sanitize_zip_entry("").is_err());
    }

    #[test]
    fn sha256_matches_known() {
        // "abc" 的 sha256。
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn manifest_validation() {
        let ok = json!({
            "schemaVersion": 1,
            "id": "com.example.todo",
            "name": "示例",
            "version": "1.0.0",
            "type": "tool",
            "main": "plugin.js"
        });
        assert!(manifest_valid_or_error(&ok).is_ok());
        let bad = json!({ "schemaVersion": 2, "id": "com.x", "name": "x", "version": "1", "type": "tool", "main": "a.js" });
        assert!(manifest_valid_or_error(&bad).is_err());
        let missing = json!({ "schemaVersion": 1, "id": "com.x", "name": "x" });
        assert!(manifest_valid_or_error(&missing).is_err());
        // theme 声明式：纯 theme 可省略 main；含代码类型则必填。
        let theme = json!({ "schemaVersion": 1, "id": "com.example.dark", "name": "x", "version": "1", "type": "theme" });
        assert!(manifest_valid_or_error(&theme).is_ok());
        let tool_no_main = json!({ "schemaVersion": 1, "id": "com.x", "name": "x", "version": "1", "type": "tool" });
        assert!(manifest_valid_or_error(&tool_no_main).is_err());
    }
}
