/**
 * 协作 presence 运行时状态：本端与 collab-relay 的连接管理 + 同仓库在线用户列表。
 *
 * 配置（开关/地址/昵称/颜色）来自 settingsStore 应用级配置；房间按 appStore.vaultId 划分，
 * 切仓库换房（bye + 重连新 hello）；表格选中变化经 `useTableStore` 订阅节流广播
 * （100ms），peers 供表格视图渲染远端选中高亮。画布/笔记 presence 后续同通道扩展。
 */
import { create } from "zustand";
import {
  connectCollabRelay,
  type CollabRelayHandle,
} from "@/services/collab/relay";
import { useAppStore } from "@/stores/appStore";
import { useTableStore } from "@/stores/tableStore";
import type { CollabPeer, CollabPresence } from "@/types";

/** 本端 presence 广播节流（选中高频变化合并，不刷屏 relay）。 */
const BROADCAST_THROTTLE_MS = 100;

export interface CollabInitConfig {
  enabled: boolean;
  url: string;
  nickname: string;
  color: string;
  deviceName: string;
}

interface CollabStoreState {
  /** 是否已连接 relay（连接中/断线重连 = false）。 */
  connected: boolean;
  /** 当前房间（同仓库 vaultId）在线用户列表。 */
  peers: CollabPeer[];

  /** 应用启动时调用：载入配置并建立连接（无配置 = 不连）。 */
  init: (cfg: CollabInitConfig) => void;
  /** 设置变更（开关/地址/昵称/颜色）：重建连接。 */
  applyConfig: (patch: Partial<Omit<CollabInitConfig, "deviceName">>) => void;
  /** 断开连接并停止广播（应用退出）。 */
  dispose: () => void;
}

/** 当前运行时配置（init/applyConfig 更新；连接按它建立）。 */
let runtimeCfg: CollabInitConfig | null = null;
let handle: CollabRelayHandle | null = null;
let currentVaultId: string | null = null;
/** 本连接在房间内的 peerId（hello-ack 分配；据此把自己过滤出 peers，防自己出现在在线列表/高亮）。 */
let myPeerId: number | null = null;
/** 节流广播暂存（节流窗口内的最新 presence）。 */
let pendingPresence: CollabPresence | null = null;
let broadcastTimer: number | null = null;
/** 表格/appStore 订阅只注册一次（init 时，确保各 store 模块已完成初始化——防循环 import 未完成期调用）。 */
let subscribed = false;

/** 随机分配身份色（未配置时；与强调色体系一致的暖色系，避免刺眼）。设置页「随机」按钮复用。 */
export function randomPeerColor(): string {
  const palette = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function establishConnection(): void {
  handle?.disconnect();
  handle = null;
  // 断线/重连期间清空在线列表与身份（残留旧 peers 会误导远端高亮）
  myPeerId = null;
  // 丢弃节流窗口内未发出的陈旧 presence（切仓库后旧文件的选中不得发进新房间）
  pendingPresence = null;
  useCollabStore.setState({ connected: false, peers: [] });
  const cfg = runtimeCfg;
  if (!cfg?.enabled || !cfg.url || !currentVaultId) return;
  handle = connectCollabRelay({
    url: cfg.url,
    hello: {
      vaultId: currentVaultId,
      nickname: cfg.nickname || cfg.deviceName || "用户",
      color: cfg.color || randomPeerColor(),
      deviceName: cfg.deviceName,
    },
    onHelloAck: (peerId) => {
      myPeerId = peerId;
      // hello-ack 先于 peers 帧到达（relay 端保证）：立即过滤已收快照里的自己
      useCollabStore.setState((s) => ({ peers: s.peers.filter((p) => p.peerId !== peerId) }));
    },
    onPeers: (peers) =>
      useCollabStore.setState({ peers: peers.filter((p) => p.peerId !== myPeerId) }),
    onPeerPresence: (peerId, presence) => {
      if (peerId === myPeerId) return;
      useCollabStore.setState((s) => ({
        peers: s.peers.map((p) => (p.peerId === peerId ? { ...p, presence } : p)),
      }));
    },
    // 表格内容补丁实时广播接收：只应用当前打开的表格（applyRemotePatch 内部按 file + 表 id 守卫）
    onTablePatch: (peerId, file, patch) => {
      if (peerId === myPeerId) return;
      useTableStore.getState().applyRemotePatch(file, patch);
    },
    // 服务端 error 帧（协议异常/房间拒绝）：协作是尽力而为的辅助能力，仅记录不打断使用
    onServerError: (message) => console.warn("协作中转错误：", message),
    onStatusChange: (connected) => {
      useCollabStore.setState({ connected });
      // 连接建立后补发一次当前 presence：重连/进房间时本端选中立即可见，
      // 否则要等用户下一次选中变化才广播（hello 已先发，同 TCP FIFO 保证先入房）
      if (connected) {
        const ts = useTableStore.getState();
        schedulePresenceBroadcast({ file: ts.tableFile, selection: ts.selection, view: ts.view });
      }
    },
  });
}

function schedulePresenceBroadcast(presence: CollabPresence): void {
  pendingPresence = presence;
  if (broadcastTimer !== null) return;
  broadcastTimer = window.setTimeout(() => {
    broadcastTimer = null;
    if (handle && pendingPresence) handle.sendPresence(pendingPresence);
    pendingPresence = null;
  }, BROADCAST_THROTTLE_MS);
}

// 表格打开/选中/视图变化 → 节流广播 presence（file null = 未看表格，清空远端高亮）；
// 切仓库（vaultId 变化）→ 换房间重连；无仓库（回启动页）→ 断开。
// 注册推迟到 init（防循环 import 链中模块未完成初始化即调用 store）
function ensureSubscriptions(): void {
  if (subscribed) return;
  subscribed = true;
  useTableStore.subscribe((s, prev) => {
    if (s.tableFile !== prev.tableFile || s.selection !== prev.selection || s.view !== prev.view) {
      schedulePresenceBroadcast({ file: s.tableFile, selection: s.selection, view: s.view });
    }
  });
  useAppStore.subscribe((s, prev) => {
    if (s.vaultId !== prev.vaultId) {
      currentVaultId = s.vaultId;
      establishConnection();
    }
  });
}

export const useCollabStore = create<CollabStoreState>((set) => ({
  connected: false,
  peers: [],

  init: (cfg) => {
    ensureSubscriptions();
    runtimeCfg = { ...cfg, color: cfg.color || randomPeerColor() };
    currentVaultId = useAppStore.getState().vaultId;
    // 注入表格补丁广播钩子（tableStore 在 schedulePersist 计算补丁后回调；handle 为模块级，
    // establishConnection 重建连接后闭包自动指向新连接，无需重注入）
    useTableStore.getState().setCollabBroadcast((file, patch) => handle?.sendTablePatch(file, patch));
    establishConnection();
  },

  applyConfig: (patch) => {
    if (!runtimeCfg) return;
    runtimeCfg = {
      ...runtimeCfg,
      ...patch,
      // 设置页未配置颜色（空串）时保留已分配的随机色，防每次设置变更/重连都换身份色
      color: patch.color || runtimeCfg.color,
    };
    establishConnection();
  },

  dispose: () => {
    handle?.sendBye();
    handle?.disconnect();
    handle = null;
    // 解除广播钩子：协作关闭后表格编辑不再走 relay（回落 watcher/磁盘通道）
    useTableStore.getState().setCollabBroadcast(null);
    runtimeCfg = null;
    myPeerId = null;
    if (broadcastTimer !== null) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    pendingPresence = null;
    set({ connected: false, peers: [] });
  },
}));
