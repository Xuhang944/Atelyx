/**
 * 单节点的协作实时状态（画布）：远端选中高亮 / 独占编辑锁主 / 生成中，供节点 HOC 与
 * ConversationNode 只读态共用。
 *
 * - 选中高亮：同一画布（presence.file + view=canvas）且 selection.kind==="node" 命中。
 * - 锁主：所有声明（本端 `lockedConversations` + 对端 presence.lockedNodes，仅按 nodeId 匹配，
 *   不按 file/view 过滤——锁跨视图保活）经 `computeLockOwner` 确定性判定（since 最小、同 since
 *   按 peerId 取小）。本端非锁主 → 只读；发送前须校验 `iOwnLock`。
 * - 生成中：对端 presence.streamingNodeIds 命中（仅按 nodeId，同锁）。
 */
import { useCollabStore } from "@/stores/collabStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAppStore } from "@/stores/appStore";
import { computeLockOwner } from "@/utils/canvasCollab";
import type { CollabPeer } from "@/types";

export interface NodeCollabState {
  /** 远端选中本节点的用户（用户色高亮叠加）。 */
  selectingPeers: CollabPeer[];
  /** 正在本节点 AI 生成的远端用户（生成中指示灯）。 */
  streamingPeers: CollabPeer[];
  /** 本节点的确定性锁主（非本端）= 该用户在独占编辑；null = 无他人持锁。 */
  lockedByPeer: CollabPeer | null;
  /** 本端是否为该节点的确定性锁主（发送/编辑前校验）。 */
  iOwnLock: boolean;
}

export function useNodeCollab(nodeId: string): NodeCollabState {
  const canvasFile = useAppStore((s) => s.currentCanvasFile);
  const peers = useCollabStore((s) => s.peers);
  const myPeerId = useCollabStore((s) => s.myPeerId);
  const myLocks = useCanvasStore((s) => s.lockedConversations);

  const selectingPeers = peers.filter(
    (p) =>
      p.presence?.file === canvasFile &&
      p.presence?.view === "canvas" &&
      p.presence?.selection?.kind === "node" &&
      p.presence.selection.nodeId === nodeId,
  );
  // 锁/流式按 nodeId 匹配（不依赖 presence.file/view——锁跨视图保活，用户看表格/笔记期间仍持锁）
  const claimPeers = peers.filter((p) => p.presence?.lockedNodes?.some((l) => l.id === nodeId));
  const streamingPeers = peers.filter((p) => p.presence?.streamingNodeIds?.includes(nodeId));

  const mySince = myLocks[nodeId];
  const claims: { peerId: number; since: number }[] = [];
  if (mySince !== undefined && myPeerId !== null) {
    claims.push({ peerId: myPeerId, since: mySince });
  }
  for (const p of claimPeers) {
    const c = p.presence!.lockedNodes!.find((l) => l.id === nodeId);
    if (c) claims.push({ peerId: p.peerId, since: c.since });
  }
  const owner = computeLockOwner(claims);
  const iOwnLock = owner !== null && owner === myPeerId;
  const lockedByPeer =
    owner !== null && !iOwnLock ? (claimPeers.find((p) => p.peerId === owner) ?? null) : null;

  return { selectingPeers, streamingPeers, lockedByPeer, iOwnLock };
}
