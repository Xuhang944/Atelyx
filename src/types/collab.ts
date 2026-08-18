/**
 * 协作（presence）类型：与 collab-relay 的 JSON 协议对齐（camelCase 透传）。
 * 本端选中状态经节流广播给同仓库在线用户，远端按此渲染高亮。
 */

/** 远端用户的选中状态（与 tableStore.selection 同构）。 */
export type CollabSelection =
  | { kind: "cell"; rowId: string; fieldId: string }
  | { kind: "row"; rowId: string }
  | { kind: "column"; fieldId: string }
  | { kind: "all" }
  | null;

/** 远端用户 presence：打开的文件 + 选中 + 编辑器视图（null = 未在看表格/笔记）。 */
export interface CollabPresence {
  file: string | null;
  selection: CollabSelection;
  view: "table" | "timeline" | "note" | null;
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
