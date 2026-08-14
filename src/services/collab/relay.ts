/**
 * 协作中转（collab-relay）WebSocket 客户端封装。
 *
 * 纯 I/O：连接/hello 入房/presence 上报/心跳保活/指数退避重连，状态与节流归 collabStore。
 * 协议见 `collab-relay/src/main.rs`（JSON，camelCase）：
 * - C→S `hello`：`{ type, vaultId, nickname, color, deviceName }`（连接后首条必发）
 * - C→S `presence`：`{ type, file?, selection?, view? }`
 * - C→S `ping`（保活）/ `bye`（离开）
 * - S→C `peers`：`{ type, peers: [...] }`（房间成员变化全量推送）
 * - S→C `presence`：`{ type, peerId, presence }`（他人转发）
 */
import type { CollabHello, CollabPeer, CollabPresence } from "@/types";

/** 心跳间隔：relay 侧 30s 无消息超时踢出，25s 发 ping 保活。 */
const HEARTBEAT_MS = 25_000;
/** 断线重连退避：1s 起，翻倍，封顶 15s。 */
const MAX_RETRY_MS = 15_000;

export type CollabClientMessage =
  | ({ type: "hello" } & CollabHello)
  | ({ type: "presence" } & CollabPresence)
  | { type: "ping" }
  | { type: "bye" };

export type CollabServerMessage =
  | { type: "peers"; peers: CollabPeer[] }
  | { type: "hello-ack"; peerId: number }
  | { type: "presence"; peerId: number; presence: CollabPresence }
  | { type: "error"; message: string };

export interface CollabRelayHandle {
  /** 上报本端 presence（调用方自行节流）。 */
  sendPresence(presence: CollabPresence): void;
  /** 主动离开房间（切仓库/关闭应用）。 */
  sendBye(): void;
  /** 断开连接且不再重连。 */
  disconnect(): void;
}

export interface CollabRelayOptions {
  url: string;
  hello: CollabHello;
  /** 收到 hello-ack（分配的本连接 peerId）——客户端据此把自己过滤出 peers 列表。 */
  onHelloAck: (peerId: number) => void;
  onPeers: (peers: CollabPeer[]) => void;
  onPeerPresence: (peerId: number, presence: CollabPresence) => void;
  onStatusChange: (connected: boolean) => void;
}

/** 连接 collab-relay。onStatusChange 初始调用一次 false（连接中），成功后 true，断线重连期间 false。 */
export function connectCollabRelay(opts: CollabRelayOptions): CollabRelayHandle {
  let ws: WebSocket | null = null;
  let closed = false; // disconnect() 后不再重连
  let alive = false; // 曾连上（避免未连接阶段的重复 false 通知）
  let retryDelay = 1000;
  let retryTimer: number | null = null;
  let heartbeatTimer: number | null = null;

  function open(): void {
    try {
      ws = new WebSocket(opts.url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      alive = true;
      retryDelay = 1000;
      opts.onStatusChange(true);
      ws?.send(JSON.stringify({ type: "hello", ...opts.hello }));
      heartbeatTimer = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (e) => {
      let msg: CollabServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "hello-ack") opts.onHelloAck(msg.peerId);
      else if (msg.type === "peers") opts.onPeers(msg.peers);
      else if (msg.type === "presence") opts.onPeerPresence(msg.peerId, msg.presence);
    };
    ws.onerror = () => ws?.close(); // 收尾统一走 onclose
    ws.onclose = () => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      ws = null;
      if (alive) {
        alive = false;
        opts.onStatusChange(false);
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (closed) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      open();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }

  open();
  opts.onStatusChange(false);

  return {
    sendPresence: (presence) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "presence", ...presence }));
    },
    sendBye: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "bye" }));
      }
    },
    disconnect: () => {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      ws?.close();
      ws = null;
      alive = false;
    },
  };
}
