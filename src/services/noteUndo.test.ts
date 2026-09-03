/**
 * 笔记撤销栈契约测试（services/noteUndo + stores/noteUndoStore）。
 *
 * 核心契约：
 * - 打字成组：一次输入组（recordEdit 间隔 < coalesceMs）只入栈组起点前的全文一条，
 *   撤销一步回到整段输入之前，而非逐键；组内后续输入不新增条目。
 * - 撤销后输入另起新组并清空 redo（新分支）。
 * - 深度/字节双上限剪枝（保最新丢最旧）。
 * - store 层按 file 键隔离：A 文件的撤销操作不影响 B 文件；clearAll 清空全部。
 */
import { describe, expect, it } from "vitest";
import { createNoteUndoStack } from "./noteUndo";
import { useNoteUndoStore } from "@/stores/noteUndoStore";

describe("createNoteUndoStack", () => {
  it("连续输入合并为一步：撤销回到整个输入组之前（非逐键）", () => {
    const s = createNoteUndoStack({ coalesceMs: 1000 });
    let now = 0;
    s.recordEdit("", now); // 组起点：输入前为空
    s.recordEdit("a", (now += 50)); // 组内：不新增
    s.recordEdit("ab", (now += 50)); // 组内：不新增
    expect(s.undo("abc")).toBe("");
    expect(s.canUndo).toBe(false);
    expect(s.redo("")).toBe("abc");
    expect(s.canRedo).toBe(false);
  });

  it("间隔超窗另起新组：逐步撤销到各自组起点", () => {
    const s = createNoteUndoStack({ coalesceMs: 1000 });
    let now = 0;
    s.recordEdit("", now); // 组1：输入前为空
    s.recordEdit("a", (now += 50)); // 组内
    s.recordEdit("ab", (now += 50)); // 组内
    s.recordEdit("abc", (now += 2000)); // 2s 后继续输入：新组，起点 = 该段输入前 = "abc"
    s.recordEdit("abcd", (now += 50)); // 组内
    expect(s.undo("abcde")).toBe("abc"); // 撤销组2（"de"）
    expect(s.undo("abc")).toBe(""); // 撤销组1（"abc"）
    expect(s.canUndo).toBe(false);
  });

  it("撤销后立即输入：另起新组并清空 redo", () => {
    const s = createNoteUndoStack({ coalesceMs: 1000 });
    let now = 0;
    s.recordEdit("", now);
    s.recordEdit("a", (now += 50));
    expect(s.undo("ab")).toBe(""); // 撤销到组起点
    expect(s.canRedo).toBe(true);
    // 撤销后输入（组计时已重置）：新组入栈 + redo 清空
    s.recordEdit("", (now += 10));
    expect(s.canRedo).toBe(false);
    expect(s.undo("x")).toBe(""); // 撤销刚输入的内容
    expect(s.canUndo).toBe(false);
  });

  it("深度上限：只保留最近 N 个组起点", () => {
    const s = createNoteUndoStack({ depth: 2, coalesceMs: 0 });
    s.recordEdit("a", 0);
    s.recordEdit("b", 1000);
    s.recordEdit("c", 2000);
    expect(s.undo("d")).toBe("c");
    expect(s.undo("c")).toBe("b");
    expect(s.canUndo).toBe(false); // "a" 已被深度剪枝淘汰
  });

  it("字节上限：超预算丢最旧保最新", () => {
    const big = "x".repeat(200);
    const s = createNoteUndoStack({ byteCap: 250, coalesceMs: 0 });
    s.recordEdit("", 0);
    s.recordEdit(big, 1000);
    s.recordEdit(big + "y", 2000); // 3 条约 400B 超 250B 预算 → 只留最新
    expect(s.undo("z")).toBe(big + "y");
    expect(s.canUndo).toBe(false);
  });

  it("undo/redo 互放：redo 恢复撤销前内容", () => {
    const s = createNoteUndoStack({ coalesceMs: 0 });
    s.recordEdit("a", 0);
    s.recordEdit("b", 1000);
    expect(s.undo("bc")).toBe("b");
    expect(s.undo("b")).toBe("a");
    expect(s.redo("a")).toBe("b");
    expect(s.redo("b")).toBe("bc");
    expect(s.canRedo).toBe(false);
  });
});

describe("useNoteUndoStore", () => {
  it("多文件栈隔离：A 的撤销不影响 B，clearAll 清空全部", () => {
    useNoteUndoStore.getState().clearAll();
    useNoteUndoStore.getState().recordEdit("A.md", "");
    useNoteUndoStore.getState().recordEdit("B.md", "");
    expect(useNoteUndoStore.getState().undo("A.md", "aa")).toBe("");
    expect(useNoteUndoStore.getState().undo("A.md", "")).toBeNull(); // A 已空
    expect(useNoteUndoStore.getState().undo("B.md", "bb")).toBe(""); // B 不受影响
    useNoteUndoStore.getState().clearAll();
    expect(useNoteUndoStore.getState().undo("A.md", "x")).toBeNull();
    expect(useNoteUndoStore.getState().undo("B.md", "x")).toBeNull();
  });

  it("同一文件共享同一栈实例（多面板语义）", () => {
    useNoteUndoStore.getState().clearAll();
    useNoteUndoStore.getState().recordEdit("C.md", "");
    useNoteUndoStore.getState().recordEdit("C.md", "c");
    // 第二次 recordEdit 命中既有栈（组内不新增），撤销回到组起点
    expect(useNoteUndoStore.getState().undo("C.md", "cd")).toBe("");
  });

  it("renameFile 迁移栈键：撤销历史随路径走、旧键清除", () => {
    useNoteUndoStore.getState().clearAll();
    useNoteUndoStore.getState().recordEdit("旧.md", "");
    useNoteUndoStore.getState().renameFile("旧.md", "新.md");
    // 新键可撤销（栈已迁移），旧键无可撤销（不滞留）
    expect(useNoteUndoStore.getState().undo("新.md", "aa")).toBe("");
    expect(useNoteUndoStore.getState().undo("旧.md", "aa")).toBeNull();
  });
});
