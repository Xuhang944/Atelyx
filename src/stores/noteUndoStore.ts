/**
 * 笔记撤销栈运行时（会话内内存驻留，不落盘）。
 *
 * 生命周期：栈只在内存——退出软件与切仓库（vaultId 变化，防跨仓库同路径
 * 串文件）时 clearAll()；切笔记、模式切换（预览↔编辑/源码）、布局/面板重挂载等一切
 * 会话内操作不清栈。
 *
 * 每文件独立栈实例（stacks 按 file 键隔离），撤销/重做按当前编辑器 file 取栈并应用，
 * 各文件互不混淆；多面板打开同一笔记共享同一栈。
 *
 * 协作语义：协作态下 ytext 远端合入/基线收敛也会经 onBodyChange 走 recordEdit 积累本地栈
 * 快照（文件内容历史视角，自洽）；撤销/重做统一走本栈（编辑态窗口级路由，见 6.4），
 * 协作/非协作一致——撤销可把此前（含远端合入）的内容一步回滚到快照。
 */
import { create } from "zustand";
import { createNoteUndoStack, type NoteUndoStack } from "@/services/noteUndo";

interface NoteUndoState {
  stacks: Record<string, NoteUndoStack>;
  /** 取某文件的撤销栈（无则懒创建；首次编辑时建一次，之后复用同一实例）。 */
  stackOf: (file: string) => NoteUndoStack;
  /** 用户输入登记：before = 本次输入前的全文（NoteEditor.handleChange 调用，连续输入合并）。 */
  recordEdit: (file: string, before: string) => void;
  /** 撤销：current = 当前全文；返回应恢复的全文，无可撤销返回 null。 */
  undo: (file: string, current: string) => string | null;
  /** 重做：current = 当前全文；返回应恢复的全文，无可重做返回 null。 */
  redo: (file: string, current: string) => string | null;
  /** 清除某文件栈（删除文件时调用，防残留内存）。 */
  clearFile: (file: string) => void;
  /** 重命名文件时迁移栈键（撤销历史随文件路径走，改名不丢、旧键不滞留）。 */
  renameFile: (oldFile: string, newFile: string) => void;
  /** 清空全部栈（切仓库/退出软件时调用）。 */
  clearAll: () => void;
}

export const useNoteUndoStore = create<NoteUndoState>((set, get) => ({
  stacks: {},

  stackOf: (file) => {
    const existing = get().stacks[file];
    if (existing) return existing;
    const stack = createNoteUndoStack();
    set((s) => ({ stacks: { ...s.stacks, [file]: stack } }));
    return stack;
  },

  recordEdit: (file, before) => {
    get().stackOf(file).recordEdit(before);
  },

  undo: (file, current) => get().stackOf(file).undo(current),
  redo: (file, current) => get().stackOf(file).redo(current),

  clearFile: (file) =>
    set((s) => {
      if (!(file in s.stacks)) return s;
      const next = { ...s.stacks };
      delete next[file];
      return { stacks: next };
    }),

  renameFile: (oldFile, newFile) =>
    set((s) => {
      const stack = s.stacks[oldFile];
      if (!stack) return s;
      const next = { ...s.stacks };
      delete next[oldFile];
      next[newFile] = stack;
      return { stacks: next };
    }),

  clearAll: () => set({ stacks: {} }),
}));
