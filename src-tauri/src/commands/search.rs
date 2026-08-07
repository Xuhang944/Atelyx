//! 联网搜索代理命令。
//!
//! 搜索统一走 Rust 侧请求，理由：
//! - **SearXNG**：自建实例无内置 CORS 支持，浏览器/WebView 前端直 fetch 必被
//!   `Access-Control-Allow-Origin` 拦截（官方架构即「放反代后面」）；Rust 代理天然绕过。
//! - **Tavily**：官方 best practice 明确 API key 不应暴露在客户端代码；key 优先从仓库
//!   `config.json` 的 `search.tavilyApiKey` 读取（`syncKeys` 开启时随仓库落盘、多设备共享），
//!   为空则回退 keychain 条目 `provider-<vaultId>-search-tavily`（默认模式，按仓库隔离）；不落 WebView。
//!
//! 边界捕获：网络/HTTP 错误返回 Err，前端 `runSearch` 降级为 `SearchResultData.error`
//! （失败降级不阻塞对话，）。

use keyring::Entry;
use serde::Serialize;
use tauri::State;

use crate::vault::{read_vault_config, VaultConfig, VaultState};

/// keychain 的 service 名（对齐 `tauri.conf.json` 的 `identifier`，与 keychain.rs 一致）。
const SERVICE: &str = "com.atelyx.app";

/// 单条搜索结果（camelCase 对齐前端 `SearchResultItem`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// 执行搜索（Tavily / SearXNG，按 provider 分发）。key 与 URL 均由 Rust 侧处理。
#[tauri::command]
pub async fn search_web(
    state: State<'_, VaultState>,
    provider: String,
    query: String,
    searxng_url: Option<String>,
) -> Result<Vec<SearchResultItem>, String> {
    let root = state.root()?;
    // 仓库配置读一次：Tavily key（syncKeys 开启时随仓库落盘）与 vault_id（keychain 回退用）
    let config = read_vault_config(&root)?;
    match provider.as_str() {
        "tavily" => tavily_search(&config, &query).await,
        "searxng" => searxng_search(searxng_url.unwrap_or_default().as_str(), &query).await,
        other => Err(format!("未知搜索源：{}", other)),
    }
}

/// 带超时的 HTTP 客户端（搜索请求不被挂死；15s 对搜索 API 足够）。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

async fn tavily_search(config: &VaultConfig, query: &str) -> Result<Vec<SearchResultItem>, String> {
    let key = get_tavily_key(config)?;
    if key.is_empty() {
        return Err("未配置 Tavily API Key（工作区「设置」→ 联网搜索）".to_string());
    }
    let client = http_client()?;
    let resp = client
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {}", key))
        .json(&serde_json::json!({ "query": query, "max_results": 5 }))
        .send()
        .await
        .map_err(|e| format!("Tavily 请求失败：{}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Tavily 请求失败：HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_results(json.get("results")))
}

async fn searxng_search(instance_url: &str, query: &str) -> Result<Vec<SearchResultItem>, String> {
    let base = instance_url.trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 SearXNG 实例 URL（工作区「设置」→ 联网搜索）".to_string());
    }
    let url = format!("{}/search?q={}&format=json", base, percent_encode(query));
    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("SearXNG 请求失败：{}", e))?;
    if !resp.status().is_success() {
        // 403 = 实例未启用 json 格式（settings.yml 的 search.formats 需加入 json）
        return Err(format!(
            "SearXNG 请求失败：HTTP {}（若 403，需在实例 settings.yml 的 search.formats 加入 json）",
            resp.status()
        ));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_results(json.get("results")))
}

/// 解析 SearXNG/Tavily 统一的 results 数组（字段：url/title/content）。
fn parse_results(results: Option<&serde_json::Value>) -> Vec<SearchResultItem> {
    results
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let url = item
                        .get("url")
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();
                    if url.is_empty() {
                        return None;
                    }
                    Some(SearchResultItem {
                        title: item
                            .get("title")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string(),
                        url,
                        snippet: item
                            .get("content")
                            .and_then(|c| c.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 读 Tavily key：优先仓库 config.json 的 `search.tavilyApiKey`（syncKeys 开启时随仓库落盘，
/// 多设备共享同一份）；为空则回退 keychain 条目 `provider-<vaultId>-search-tavily`（默认模式）。
fn get_tavily_key(config: &VaultConfig) -> Result<String, String> {
    if let Some(k) = config
        .search
        .as_ref()
        .and_then(|s| s.tavily_api_key.as_deref())
    {
        if !k.is_empty() {
            return Ok(k.to_string());
        }
    }
    let vault_id = config.vault_id.as_deref().unwrap_or_default();
    let entry = Entry::new(SERVICE, &format!("provider-{}-search-tavily", vault_id))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 简单百分号编码（UTF-8 字节；SearXNG 查询参数用）。
fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
