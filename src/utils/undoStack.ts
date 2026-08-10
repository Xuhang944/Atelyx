/**
 * 通用撤销/重做栈（快照式）：画布（nodes/edges/messages）与表格（fields/rows）共用。
 * 语义对齐画布既有实现：
 * - push()：快照当前状态入 undo 栈（栈深 max），并清空 redo 栈
 * - touchRedo()：非入栈的数据变更后调用——undo 后产生任何新变更，redo 不得再恢复旧快照
 * - undo()/redo()：弹栈并 apply；副作用（中止流、撤销后落盘）由调用方包装层处理
 * - clear()：切换文件/画布时清空两栈（快照含文件内容，混用会串文件污染撤销）
 *
 * 快照/应用由各 store 传入（structuredClone 的代价由快照语义承担，同画布历史实现）。
 */
export interface UndoManager {
  push(): void;
  touchRedo(): void;
  undo(): boolean;
  redo(): boolean;
  /** 撤销栈顶条目数（编辑会话入栈深度记录用）。 */
  readonly size: number;
  /**
   * 丢弃撤销栈顶条目（编辑会话中止、丢弃空撤销单元时用）：
   * 恢复入栈前被清空的 redo 栈，等效「这次 push 从未发生」。
   */
  dropTop(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  clear(): void;
}

export function createUndoManager<T>(opts: {
  max?: number;
  /** 快照当前状态（push / undo 入 redo 栈前调用）。 */
  snapshot: () => T;
  /** 应用快照到运行时状态（undo/redo 时调用）。 */
  apply: (entry: T) => void;
}): UndoManager {
  const max = opts.max ?? 50;
  let undoStack: T[] = [];
  let redoStack: T[] = [];
  /** push 时被清空的 redo 栈（dropTop 丢弃该条目时恢复，会话式入口防误毁 redo）。 */
  let redoCheckpoint: T[] | null = null;
  return {
    push() {
      redoCheckpoint = redoStack;
      undoStack = [...undoStack, opts.snapshot()].slice(-max);
      redoStack = [];
    },
    touchRedo() {
      redoStack = [];
    },
    undo() {
      const prev = undoStack[undoStack.length - 1];
      if (!prev) return false;
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, opts.snapshot()];
      opts.apply(prev);
      return true;
    },
    redo() {
      const next = redoStack[redoStack.length - 1];
      if (!next) return false;
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, opts.snapshot()];
      opts.apply(next);
      return true;
    },
    get size() {
      return undoStack.length;
    },
    dropTop() {
      const top = undoStack[undoStack.length - 1];
      if (!top) return false;
      undoStack = undoStack.slice(0, -1);
      if (redoCheckpoint) redoStack = redoCheckpoint;
      redoCheckpoint = null;
      return true;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    clear() {
      undoStack = [];
      redoStack = [];
      redoCheckpoint = null;
    },
  };
}
