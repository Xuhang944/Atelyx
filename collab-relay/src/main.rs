//! Atelyx 局域网协作中转（presence + 表格补丁 relay）。
//!
//! 无状态 WebSocket hub：客户端按仓库 id（vaultId）分房间，转发 presence（在线用户 + 打开文件 +
//! 选中状态）与表格内容补丁（`table-patch`，实时协作内容通道）。纯转发不持久化——断线即消失，
//! 30s 无消息心跳超时踢出。无鉴权（局域网信任）：同一局域网内任何客户端可加入房间；单端口，
//! 部署 = 服务器 `git clone && docker compose up -d`。
//!
//! 协议（JSON over WS，字段 camelCase）：
//! - C→S `hello`：`{ type, vaultId, nickname, color, deviceName }`（首条必发）
//! - C→S `presence`：`{ type, file?, selection?, view? }`（选中变化节流后发）
//! - C→S `table-patch`：`{ type, file, patch }`（表格增量补丁广播；patch 不透明透传，
//!   客户端按 file 匹配只应用当前打开的表格）
//! - C→S `ping`（保活）/ `bye`（离开）
//! - S→C `hello-ack`：`{ type, peerId }`（分配的本连接 id，先于 peers 帧——客户端据此把自己过滤出列表）
//! - S→C `peers`：`{ type, peers: [{ peerId, nickname, color, deviceName, presence? }] }`
//!   （房间成员变化时全量推送；presence 字段 = `{ file?, selection?, view? }`）
//! - S→C `presence`：`{ type, peerId, presence }`（他人 presence 转发，不含自己）
//! - S→C `table-patch`：`{ type, peerId, file, patch }`（他人补丁转发，不含自己）
//! - S→C `error`：`{ type, message }`

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// 心跳超时：期间无任何消息（含 ping）即断开。
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

static NEXT_PEER_ID: AtomicU64 = AtomicU64::new(1);

type Rooms = HashMap<String, Room>;
/// 房间 = 同一 vaultId 的在线连接；每连接一个 broadcast 通道（转发出站消息）。
type Room = HashMap<u64, PeerEntry>;

struct PeerEntry {
    peer_id: u64,
    nickname: String,
    color: String,
    device_name: String,
    presence: Option<Presence>,
    tx: broadcast::Sender<Arc<String>>,
}

/// 全局房间表（vaultId → 房间）；hub 为 axum State。
#[derive(Clone)]
struct Hub(Arc<Mutex<Rooms>>);

impl Default for Hub {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientMsg {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    vault_id: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    selection: Option<serde_json::Value>,
    #[serde(default)]
    view: Option<String>,
    /// 表格增量补丁（`table-patch` 消息；不透明透传，relay 不解析内容）。
    #[serde(default)]
    patch: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Presence {
    file: Option<String>,
    selection: Option<serde_json::Value>,
    view: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerInfo {
    peer_id: u64,
    nickname: String,
    color: String,
    device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    presence: Option<Presence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMsg {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peers: Option<Vec<PeerInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presence: Option<Presence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    patch: Option<serde_json::Value>,
}

fn server_msg(
    kind: &'static str,
    peer_id: Option<u64>,
    peers: Option<Vec<PeerInfo>>,
    presence: Option<Presence>,
    file: Option<String>,
    patch: Option<serde_json::Value>,
) -> Arc<String> {
    let json =
        serde_json::to_string(&ServerMsg { kind, peer_id, peers, presence, file, patch }).unwrap();
    Arc::new(json)
}

fn peer_error(text: &str) -> String {
    serde_json::json!({ "type": "error", "message": text }).to_string()
}

/// 向房间全员广播 peers 全量快照（成员加入/离开时调用）。
fn broadcast_peers(rooms: &Rooms, vault_id: &str) {
    let Some(room) = rooms.get(vault_id) else {
        return;
    };
    let peers: Vec<PeerInfo> = room
        .values()
        .map(|p| PeerInfo {
            peer_id: p.peer_id,
            nickname: p.nickname.clone(),
            color: p.color.clone(),
            device_name: p.device_name.clone(),
            presence: p.presence.clone(),
        })
        .collect();
    let payload = server_msg("peers", None, Some(peers), None, None, None);
    for p in room.values() {
        let _ = p.tx.send(payload.clone());
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let port = std::env::var("PORT").unwrap_or_else(|_| "17701".to_string());
    let addr = format!("0.0.0.0:{port}");
    let app = Router::new().route("/ws", get(ws_handler)).with_state(Hub::default());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr} 失败：{e}"));
    tracing::info!("collab-relay 已启动，监听 {addr}（/ws）");
    axum::serve(listener, app).await.expect("服务器错误");
}

async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<Hub>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, hub))
}

async fn handle_socket(socket: WebSocket, hub: Hub) {
    let (mut sink, mut stream) = socket.split();

    // 首条消息必须是 hello（带超时保护，防半开连接占位）
    let hello = match tokio::time::timeout(HEARTBEAT_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            match serde_json::from_str::<ClientMsg>(&text) {
                Ok(m) if m.kind == "hello" => m,
                _ => {
                    let _ = sink.send(Message::Text(peer_error("首条消息须为 hello").into())).await;
                    return;
                }
            }
        }
        _ => return,
    };

    let peer_id = NEXT_PEER_ID.fetch_add(1, Ordering::Relaxed);
    let (btx, _) = broadcast::channel::<Arc<String>>(256);
    // 后台转发必须先就位（订阅 receiver），再入房广播——否则本连接的首次 peers 帧
    // （含自己）在 send_task 启动前被 send 丢弃（broadcast 无 receiver 时 send 直接 Err）
    let mut btx_rx = btx.subscribe();
    let send_task = tokio::spawn(async move {
        loop {
            match btx_rx.recv().await {
                Ok(payload) => {
                    if sink.send(Message::Text((*payload).clone().into())).await.is_err() {
                        break;
                    }
                }
                // 消费过慢被广播层裁剪（lagged）：跳过该帧继续，防发送任务误退出
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    // 先告知本连接自己的 peerId（客户端据此把自己过滤出 peers），再广播全量快照——
    // 顺序颠倒会让客户端收到含自己的 peers 帧时还无法识别自己（一帧闪现）
    let _ = btx.send(server_msg("hello-ack", Some(peer_id), None, None, None, None));
    {
        let mut rooms = hub.0.lock().unwrap();
        let room = rooms.entry(hello.vault_id.clone()).or_default();
        room.insert(
            peer_id,
            PeerEntry {
                peer_id,
                nickname: hello.nickname,
                color: hello.color,
                device_name: hello.device_name,
                presence: None,
                tx: btx.clone(),
            },
        );
        broadcast_peers(&rooms, &hello.vault_id);
    }

    // 消息循环：30s 无消息（心跳超时）断开
    loop {
        let recv = tokio::time::timeout(HEARTBEAT_TIMEOUT, stream.next()).await;
        match recv {
            Err(_) => break,                       // 心跳超时
            Ok(None) | Ok(Some(Err(_))) => break,  // 断开/协议错误
            Ok(Some(Ok(Message::Text(text)))) => {
                let Ok(msg) = serde_json::from_str::<ClientMsg>(&text) else {
                    continue;
                };
                match msg.kind.as_str() {
                    "presence" => {
                        let presence = Presence {
                            file: msg.file,
                            selection: msg.selection,
                            view: msg.view,
                        };
                        let mut rooms = hub.0.lock().unwrap();
                        if let Some(room) = rooms.get_mut(&hello.vault_id) {
                            if let Some(peer) = room.get_mut(&peer_id) {
                                peer.presence = Some(presence.clone());
                            }
                            let payload =
                                server_msg("presence", Some(peer_id), None, Some(presence), None, None);
                            for (id, peer) in room.iter() {
                                if *id != peer_id {
                                    let _ = peer.tx.send(payload.clone());
                                }
                            }
                        }
                    }
                    // 表格内容补丁：不存储、不透传解析，原样转发房间内其他成员（客户端按 file 匹配）
                    "table-patch" => {
                        if let (Some(file), Some(patch)) = (msg.file, msg.patch) {
                            let mut rooms = hub.0.lock().unwrap();
                            if let Some(room) = rooms.get_mut(&hello.vault_id) {
                                let payload = server_msg(
                                    "table-patch",
                                    Some(peer_id),
                                    None,
                                    None,
                                    Some(file),
                                    Some(patch),
                                );
                                for (id, peer) in room.iter() {
                                    if *id != peer_id {
                                        let _ = peer.tx.send(payload.clone());
                                    }
                                }
                            }
                        }
                    }
                    "bye" => break,
                    "ping" => continue,
                    _ => continue,
                }
            }
            Ok(Some(Ok(_))) => continue, // 二进制帧/关闭帧忽略
        }
    }

    // 离开：移出房间 + 广播更新后的 peers（房间空则整体移除）
    {
        let mut rooms = hub.0.lock().unwrap();
        if let Some(room) = rooms.get_mut(&hello.vault_id) {
            room.remove(&peer_id);
            if room.is_empty() {
                rooms.remove(&hello.vault_id);
            } else {
                broadcast_peers(&rooms, &hello.vault_id);
            }
        }
    }
    send_task.abort();
}
