/**
 * 协作（presence）类型：与 collab-relay 的 JSON 协议对齐（camelCase 透传）。
 * 本端选中状态经节流广播给同仓库在线用户，远端按此渲染高亮。
 */

/** 远端用户的选中状态（表格单元格 / 画布节点）。 */
export type CollabSelection =
  | { kind: "cell"; rowId: string; fieldId: string }
  | { kind: "row"; rowId: string }
  | { kind: "column"; fieldId: string }
  | { kind: "node"; nodeId: string }
  | { kind: "all" }
  | null;

/** 画布对话节点独占编辑锁声明（presence 携带）。
 * 确定性锁主判定 = since 最小；同 since 按 peerId 递增取小（relay 全局递增分配，确定性）。 */
export interface CollabLockClaim {
  /** 对话节点 id。 */
  id: string;
  /** 获取时间戳（ms）。 */
  since: number;
}

/** 远端用户 presence：打开的文件 + 选中 + 编辑器视图（null = 未在看表格/笔记）。 */
export interface CollabPresence {
  file: string | null;
  selection: CollabSelection;
  view: "table" | "timeline" | "note" | "canvas" | null;
  /** 画布对话节点独占编辑锁（跨视图保活：用户看表格/笔记期间锁仍对端可见）。 */
  lockedNodes?: CollabLockClaim[];
  /** 画布正在 AI 生成的对话节点（生成中指示灯）。 */
  streamingNodeIds?: string[];
}

/** 房间（同仓库 vaultId）内一个在线用户。 */
export interface CollabPeer {
  peerId: number;
  nickname: string;
  color: string;
  deviceName: string;
  presence: CollabPresence | null;
}

/** 连接时的身份声明（hello 消息，进入 vaultId 房间）。 */
export interface CollabHello {
  vaultId: string;
  nickname: string;
  color: string;
  deviceName: string;
}
