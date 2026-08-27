//! 撕裂面板窗口管理（多窗口面板体系）。
//!
//! 前端 `services/window.ts::createPanelWindow` invoke 本命令，在 Rust 侧建窗口
//! （Rust 侧创建无需 JS 侧 webview 创建权限；url 同主入口，前端按 label 分流渲染单面板）。

use serde::Deserialize;
use tauri::{window::Color, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 撕裂窗口加载地址：统一 `WebviewUrl::App("index.html")`（受信任协议，与主窗口同机制）。
fn panel_url() -> WebviewUrl {
    WebviewUrl::App("index.html".into())
}

/// 窗口位置尺寸（logical px，与前端 `DetachedWindow.bounds` 一致）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 创建撕裂面板窗口（label = `panel-<id>`）。已存在（恢复防重）时直接返回 true。
///
/// Windows 关键约束（tauri 官方文档记录、[wry#583](https://github.com/tauri-apps/wry/issues/583)）：
/// `WebviewWindowBuilder::build()` 在**同步命令**或事件处理器里调用会**死锁**——同步命令跑在
/// 主线程 IPC 派发上下文，build() 内部 WebView2 异步创建（wry `wait_with_pump`）需要事件循环
/// 在正常派发点泵消息，主线程被同步命令占用即互相等待、build() 永不返回（白屏 + 主窗口控制
/// 失效）。正确做法是 **async 命令 + 独立线程**：build() 在 async runtime 线程执行，经
/// `Message::CreateWindow` 投递主事件循环，在正常派发点创建窗口。故本命令为 async，
/// **不**用 `run_on_main_thread` 包裹 build()（投递到主线程内 build() 正是死锁路径）。
#[tauri::command]
pub async fn create_panel_window(
    app: AppHandle,
    label: String,
    title: String,
    bounds: WindowBounds,
) -> Result<bool, String> {
    if app.get_webview_window(&label).is_some() {
        return Ok(true);
    }
    let builder = WebviewWindowBuilder::new(&app, &label, panel_url())
        .title(title)
        .inner_size(bounds.width, bounds.height)
        .position(bounds.x, bounds.y)
        // 与主窗口一致的自定义标题栏（decorations: false + 前端 TitleBarControls）
        .decorations(false)
        .resizable(true)
        .min_inner_size(320.0, 240.0)
        // 启动背景色 = 主窗口 tauri.conf.json 的 backgroundColor（#1e1e1e），防新建窗口白闪
        .background_color(Color(30, 30, 30, 255));
    let win = builder.build();
    match win {
        Ok(win) => {
            let _ = win.set_focus();
        }
        Err(e) => {
            // if cfg! 而非 #[cfg]：e 语法上被引用，release 不触发 unused_variables 告警（恒假分支被消除）
            if cfg!(debug_assertions) {
                eprintln!("[panel:{label}] build 失败: {e}");
            }
        }
    }
    Ok(true)
}

/// 鼠标左键当前是否按下（跨窗口拖拽释放检测）。
///
/// 标签拖出窗口后，webview 收不到窗口外的 pointerup（窗口外指针事件不可靠），
/// 拖拽会话无法结束、drop 指示器残留——前端在拖拽活跃期间轮询本命令，
/// 物理检测左键松开即终止会话。仅 Windows 支持（GetAsyncKeyState），
/// 其他平台返回 None（前端降级为超时兜底）。
#[tauri::command]
pub fn is_mouse_left_down() -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        // VK_LBUTTON = 0x01；返回 SHORT 最高位 = 按键处于按下状态（负值即按下）
        let state = unsafe { winapi::um::winuser::GetAsyncKeyState(0x01) };
        return Some(state < 0);
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}
