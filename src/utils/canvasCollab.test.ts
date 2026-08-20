/**
 * 画布协作纯函数契约测试（utils/canvasCollab）。
 *
 * - `diffCanvasEntities`：引用 diff（未变实体引用相同即不产生补丁；消息数组引用变化计入）。
 * - `computeCanvasCollabPatch`：空补丁返回 null；conversation 消息嵌入、text 有 file 剥离 bodyMd。
 * - `mergeMessages`：并发 append 都保留（确定性）；远端空/本地空语义。
 * - `computeLockOwner`：since 最小者持有、同 since 按 peerId 确定性取小。
 */
import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import type { CanvasEdge, Message } from "@/types";
import {
  computeCanvasCollabPatch,
  computeLockOwner,
  deserializeNodeForCollab,
  diffCanvasEntities,
  mergeMessages,
} from "./canvasCollab";

function node(id: string, x = 0, data: Record<string, unknown> = {}): Node {
  return { id, type: "text", position: { x, y: 0 }, width: 100, height: 50, data };
}

function convNode(id: string, x = 0): Node {
  return { id, type: "conversation", position: { x, y: 0 }, width: 200, height: 100, data: {} };
}

function msg(id: string): Message {
  return {
    id,
    conversationId: "c1",
    role: "user",
    content: `msg-${id}`,
    createdAt: 0,
  } as Message;
}

const edge = (id: string, source: string, target: string): CanvasEdge =>
  ({ id, source, target, directed: true }) as CanvasEdge;

describe("diffCanvasEntities", () => {
  it("未变实体（同引用）不产生补丁", () => {
    const n = node("a");
    const e = edge("e1", "a", "b");
    const baseline = { nodes: [n], edges: [e], messagesByConv: {} };
    const d = diffCanvasEntities([n], [e], {}, baseline);
    expect([...d.upsertNodeIds]).toEqual([]);
    expect(d.removedNodeIds).toEqual([]);
    expect([...d.upsertEdgeIds]).toEqual([]);
    expect(d.removedEdgeIds).toEqual([]);
  });

  it("引用变化/新增/删除被捕获", () => {
    const a = node("a");
    const b = node("b");
    const e1 = edge("e1", "a", "b");
    const baseline = { nodes: [a, b], edges: [e1], messagesByConv: {} };
    // a 位置变化（新对象）、b 删除、c 新增、e1 删除
    const aMoved = { ...a, position: { x: 99, y: 0 } };
    const c = node("c", 5);
    const d = diffCanvasEntities([aMoved, c], [], {}, baseline);
    expect([...d.upsertNodeIds].sort()).toEqual(["a", "c"]);
    expect(d.removedNodeIds.sort()).toEqual(["b"]);
    expect(d.removedEdgeIds).toEqual(["e1"]);
  });

  it("对话节点消息数组引用变化计入节点 upsert", () => {
    const c = convNode("c1");
    const baseline = { nodes: [c], edges: [], messagesByConv: { c1: [] } };
    const msgs = [msg("m1")];
    const d = diffCanvasEntities([c], [], { c1: msgs }, baseline);
    expect([...d.upsertNodeIds]).toEqual(["c1"]);
  });
});

describe("computeCanvasCollabPatch", () => {
  it("无变化返回 null", () => {
    const n = node("a");
    const baseline = { nodes: [n], edges: [], messagesByConv: {}, title: "画布" };
    const p = computeCanvasCollabPatch({
      canvasId: "cv",
      title: "画布",
      nodes: [n],
      edges: [],
      messagesByConv: {},
      lastSaved: baseline,
    });
    expect(p).toBeNull();
  });

  it("conversation 补丁嵌入 messages；接收端反解剥离回 messagesByConv", () => {
    const c = convNode("c1");
    const baseline = { nodes: [c], edges: [], messagesByConv: {}, title: "画布" };
    const msgs = [msg("m1"), msg("m2")];
    const p = computeCanvasCollabPatch({
      canvasId: "cv",
      title: "画布",
      nodes: [c],
      edges: [],
      messagesByConv: { c1: msgs },
      lastSaved: baseline,
    });
    expect(p).not.toBeNull();
    expect(p!.upsertNodes).toHaveLength(1);
    const filed = p!.upsertNodes[0];
    expect((filed.data as { messages?: Message[] }).messages).toHaveLength(2);
    const back = deserializeNodeForCollab(filed);
    expect(back.messages).toHaveLength(2);
    expect((back.node.data as Record<string, unknown>).messages).toBeUndefined();
  });

  it("text 有 file 剥离 bodyMd 只携带结构；接收端标记补读正文", () => {
    const n = node("t1", 0, { title: "笔记", file: "笔记/a.md", bodyMd: "hello" });
    // 基线不含该节点（视为新增）→ 产生补丁
    const baseline = { nodes: [], edges: [], messagesByConv: {}, title: "画布" };
    const p = computeCanvasCollabPatch({
      canvasId: "cv",
      title: "画布",
      nodes: [n],
      edges: [],
      messagesByConv: {},
      lastSaved: baseline,
    });
    const filed = p!.upsertNodes[0];
    expect((filed.data as { bodyMd?: string }).bodyMd).toBeUndefined();
    expect((filed.data as { file?: string }).file).toBe("笔记/a.md");
    expect(deserializeNodeForCollab(filed).refreshBodyMdFile).toBe("笔记/a.md");
  });
});

describe("mergeMessages", () => {
  it("远端基底 + 本地独有消息按原序补入（并发 append 都保留）", () => {
    const remote = [msg("m1"), msg("m3")];
    const local = [msg("m1"), msg("m2")];
    const merged = mergeMessages(remote, local);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
  });

  it("任一侧为空：远端空保留本地（本端进行中消息不丢）；本地空用远端", () => {
    expect(mergeMessages([], [msg("m1")]).map((m) => m.id)).toEqual(["m1"]);
    expect(mergeMessages([msg("m1")], []).map((m) => m.id)).toEqual(["m1"]);
    expect(mergeMessages([], [])).toEqual([]);
  });

  it("远端已含本地全部消息 → 直接用远端（幂等无重复）", () => {
    const remote = [msg("m1"), msg("m2")];
    const merged = mergeMessages(remote, [msg("m1"), msg("m2")]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("computeLockOwner", () => {
  it("since 最小者持有；同 since 按 peerId 递增取小（确定性）", () => {
    // 两人先后声明同一节点
    expect(computeLockOwner([{ peerId: 5, since: 200 }, { peerId: 3, since: 100 }])).toBe(3);
    // 同 since → 小 peerId 胜
    expect(computeLockOwner([{ peerId: 5, since: 100 }, { peerId: 3, since: 100 }])).toBe(3);
    // 交换输入顺序结果不变（确定性）
    expect(computeLockOwner([{ peerId: 3, since: 100 }, { peerId: 5, since: 200 }])).toBe(3);
    // 无声明 → null
    expect(computeLockOwner([])).toBeNull();
  });
});
