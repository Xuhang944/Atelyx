/**
 * 笔记协作合并契约测试。
 *
 * - 纯 Yjs 层：`baselineSeedUpdate` 幂等、安全路径（同开同 seed、并发、两端重开）锁定不变。
 * - 协议层（noteDoc API）：重开「磁盘基线翻倍」修复——在线端收敛到磁盘权威基线、防环、
 *   dirty 挂起后按最新落盘收敛不丢最后协作者版本。
 *
 * 背景（防重开「磁盘基线翻倍」，见 noteDoc.ts 头部「磁盘基线收敛」）：
 * 幂等仅当所有对端把全文放进同一个 seed 基线（clientID=1、确定性字节）时成立。重开端把
 * 「已合并磁盘全文」塞进新 seed 基线，与在线端「旧基线 + 真实 cid 编辑」拓扑相加即翻倍。
 * 修复 = 重开先广播 BASELINE_RESET(磁盘全文)；在线端 clean 整体重建、dirty 挂起，收敛到同一
 * 确定性基线后互换幂等（probe1 锚点）。
 */
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Text as YText } from "yjs";
import * as encoding from "lib0/encoding";
import {
  applyLocalBody,
  baselineSeedUpdate,
  bindNoteDoc,
  markNoteDiskWrite,
  receiveSyncMessage,
  setNoteCollabBroadcast,
  setNoteCollabBindingRefresh,
  destroyAllNoteDocs,
} from "./noteDoc";

const F = "notes/a.md";
const countOf = (s: string, needle: string) => s.split(needle).length - 1;
const textOf = (d: Y.Doc) => d.getText("text").toString();

const MESSAGE_BASELINE_RESET = 0x42;
function encodeBaselineReset(text: string): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_BASELINE_RESET);
  encoding.writeVarString(enc, text);
  return encoding.toUint8Array(enc);
}

/** noteDoc 为单设备单例（entries / broadcast 模块级），测试以「当前设备」视角挂钩广播与重建。 */
let sent: { file: string; payload: Uint8Array }[] = [];
let rebuilds: YText[] = [];
let refreshCount = 0;
beforeEach(() => {
  destroyAllNoteDocs();
  sent = [];
  rebuilds = [];
  refreshCount = 0;
  setNoteCollabBindingRefresh((_f, doc) => {
    refreshCount += 1;
    rebuilds.push(doc.ytext);
  });
  setNoteCollabBroadcast({
    sendSyncMessage: (file, payload) => sent.push({ file, payload }),
    sendAwareness: () => {},
  });
});
afterEach(() => {
  setNoteCollabBindingRefresh(null);
  setNoteCollabBroadcast(null);
  destroyAllNoteDocs();
});

// ===== 纯 Yjs 层：seed 幂等 =====

describe("baselineSeedUpdate 幂等", () => {
  it("空 doc 应用一次 == 原文", () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, baselineSeedUpdate("你好世界 abc123"));
    expect(textOf(d)).toBe("你好世界 abc123");
  });

  it("同文本应用两次不翻倍", () => {
    const d = new Y.Doc();
    Y.applyUpdate(d, baselineSeedUpdate("abc"));
    Y.applyUpdate(d, baselineSeedUpdate("abc"));
    expect(textOf(d)).toBe("abc");
  });

  it("同一正文各对端生成的基线 update 字节一致（确定性）", () => {
    const t = "一段确定性文本 seed。";
    expect(baselineSeedUpdate(t)).toEqual(baselineSeedUpdate(t));
  });

  it("probe1 锚点：两个都 carry 同一 client1=全文 的 doc 互换幂等不翻倍", () => {
    const M = "D0 text. A-edited B-edited ";
    const a = new Y.Doc();
    Y.applyUpdate(a, baselineSeedUpdate(M));
    const b = new Y.Doc();
    Y.applyUpdate(b, baselineSeedUpdate(M));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(textOf(a)).toBe(M);
    expect(textOf(b)).toBe(M);
    expect(countOf(textOf(a), "A-edited")).toBe(1);
  });
});

// ===== 纯 Yjs 层：安全路径锁定不变 =====

describe("安全路径（当前即正确，锁定不变）", () => {
  const createDoc = (text: string, cid: number) => {
    const d = new Y.Doc();
    Y.applyUpdate(d, baselineSeedUpdate(text));
    d.clientID = cid;
    return d;
  };
  const fullSync = (src: Y.Doc, dst: Y.Doc) =>
    Y.applyUpdate(dst, Y.encodeStateAsUpdate(src), "remote");

  it("E1 同开同 seed，两端并发编辑 + 实时同步 → 收敛不翻倍", () => {
    const A = createDoc("D0 text. ", 123);
    const B = createDoc("D0 text. ", 456);
    A.getText("text").insert(9, "A-edited ");
    B.getText("text").insert(9, "B-edited ");
    fullSync(A, B);
    fullSync(B, A);
    const r = textOf(A);
    expect(textOf(A)).toBe(textOf(B));
    expect(countOf(r, "A-edited ")).toBe(1);
    expect(countOf(r, "B-edited ")).toBe(1);
  });

  it("E2 并发插入/删除在同基线上正常收敛（CRDT 语义）", () => {
    const A = createDoc("hello", 123);
    const B = createDoc("hello", 456);
    A.getText("text").insert(2, "XX");
    B.getText("text").delete(0, 2);
    fullSync(A, B);
    fullSync(B, A);
    expect(textOf(A)).toBe(textOf(B));
  });

  it("E5 两端都关、外部改磁盘、都重开 seed 同一磁盘 → 收敛不翻倍", () => {
    const A = createDoc("new-D ", 123);
    const B = createDoc("new-D ", 456);
    A.getText("text").insert(A.getText("text").length, "A2 ");
    B.getText("text").insert(B.getText("text").length, "B2 ");
    fullSync(A, B);
    fullSync(B, A);
    const r = textOf(A);
    expect(countOf(r, "A2 ")).toBe(1);
    expect(countOf(r, "B2 ")).toBe(1);
  });
});

// ===== 协议层：磁盘基线收敛 =====

describe("重开磁盘基线收敛（防翻倍）", () => {
  it("E3 在线端打开旧基线并编辑落盘 → 收到重开 RESET(同磁盘) → 收敛重建，不翻倍", () => {
    // 在线端 A：以 D0 为基线，编辑收敛到 M，已落盘
    const a = bindNoteDoc(F, "D0 text.");
    a.ytext.insert(a.ytext.length, "A-edited B-edited");
    const M = a.ytext.toString();
    markNoteDiskWrite(F);
    // 重开端 B 带磁盘 M 广播 RESET 到达 A
    receiveSyncMessage(F, encodeBaselineReset(M));
    // A 应整体重建到 client1=M，且仅一次
    expect(refreshCount).toBe(1);
    const rebuilt = rebuilds[rebuilds.length - 1].toString();
    expect(rebuilt).toBe(M);
    expect(countOf(rebuilt, "A-edited B-edited")).toBe(1);
  });

  it("E4 在线端旧基线，重开端磁盘已被推进（Mp）→ 收敛到 Mp 不翻倍", () => {
    const a = bindNoteDoc(F, "D0 text.");
    a.ytext.insert(a.ytext.length, "A-edited B-edited A-追加");
    const Mp = a.ytext.toString();
    markNoteDiskWrite(F);
    receiveSyncMessage(F, encodeBaselineReset(Mp));
    expect(refreshCount).toBe(1);
    expect(rebuilds[rebuilds.length - 1].toString()).toBe(Mp);
    expect(countOf(rebuilds[rebuilds.length - 1].toString(), "A-追加")).toBe(1);
  });

  it("防环：同基线 RESET 再到达 → no-op（不重复重建）", () => {
    const a = bindNoteDoc(F, "D0 text.");
    a.ytext.insert(a.ytext.length, "edits");
    markNoteDiskWrite(F);
    receiveSyncMessage(F, encodeBaselineReset(a.ytext.toString()));
    expect(refreshCount).toBe(1);
    // 再次同基线通告
    receiveSyncMessage(F, encodeBaselineReset(a.ytext.toString()));
    expect(refreshCount).toBe(1); // 未再重建
  });

  it("dirty 挂起：在线端正在输入（未落盘）收到异基线 RESET → 不立即收敛、不吞输入", () => {
    const a = bindNoteDoc(F, "D0 text.");
    // dirty：编辑器已输入但尚未落盘（lastFlushed 仍是 seed 文本）
    a.ytext.insert(a.ytext.length, "在线端-CURRENT");
    const dirtyText = a.ytext.toString();
    // 重开端带异磁盘基线 Mp 的 RESET：本地 != lastFlushed → 挂起，不重建
    const Mp = "D0 text. 对端已合并内容";
    receiveSyncMessage(F, encodeBaselineReset(Mp));
    expect(refreshCount).toBe(0); // 未重建
    expect(a.ytext.toString()).toBe(dirtyText); // 输入保留
    // 落盘推进磁盘（写入 dirtyText）→ 触发收敛到最新落盘文本（保留最后协作者版本）
    markNoteDiskWrite(F);
    expect(refreshCount).toBe(1);
    expect(rebuilds[rebuilds.length - 1].toString()).toBe(dirtyText);
    expect(countOf(rebuilds[rebuilds.length - 1].toString(), "在线端-CURRENT")).toBe(1);
  });

  it("dirty 挂起落在旧基线磁盘：落盘后收敛到自身最新落盘文本，不丢输入", () => {
    const a = bindNoteDoc(F, "D0 text.");
    a.ytext.insert(a.ytext.length, "在线端-NEW");
    const myFlushed = a.ytext.toString(); // 本地落盘时会写入的自身文本
    // 重开端带新磁盘 Mp 的 RESET；本地 dirty → 挂起
    const Mp = "D0 text. 对端已合并内容";
    receiveSyncMessage(F, encodeBaselineReset(Mp));
    expect(refreshCount).toBe(0);
    // 本地落盘（写入自身文本，≠ Mp）→ 收敛到自身最新落盘文本，保留输入
    markNoteDiskWrite(F);
    expect(refreshCount).toBe(1);
    expect(rebuilds[rebuilds.length - 1].toString()).toBe(myFlushed);
    expect(countOf(rebuilds[rebuilds.length - 1].toString(), "在线端-NEW")).toBe(1);
  });

  it("重建后 binding 刷新 & 房间重新收敛（RESET + syncStep1 重发）", () => {
    const a = bindNoteDoc(F, "D0 text.");
    a.ytext.insert(a.ytext.length, " edits");
    const M = a.ytext.toString(); // "D0 text. edits"
    markNoteDiskWrite(F);
    const beforeRebuildBroadcasts = sent.length;
    receiveSyncMessage(F, encodeBaselineReset(M));
    // 重建触发 new ytext + 重发 RESET & syncStep1
    expect(refreshCount).toBe(1);
    expect(sent.length).toBeGreaterThan(beforeRebuildBroadcasts);
  });
});

// ===== 协议层：源码模式本地正文同步（切回实时预览不被陈旧 ytext 回退）=====

describe("applyLocalBody（源码模式编辑同步 ytext）", () => {
  it("不同正文 → ytext 整体替换（旧内容不残留；正文由调用方传 LF 归一化）", () => {
    const a = bindNoteDoc(F, "old body content");
    applyLocalBody(F, "new body\nwith LF");
    expect(a.ytext.toString()).toBe("new body\nwith LF");
  });

  it("相同正文 → no-op（不产生 ytext update，无广播增量）", () => {
    bindNoteDoc(F, "same body");
    const before = sent.length;
    applyLocalBody(F, "same body");
    expect(sent.length).toBe(before);
  });

  it("无 entry → no-op（不崩）", () => {
    expect(() => applyLocalBody(F, "anything")).not.toThrow();
  });
});
