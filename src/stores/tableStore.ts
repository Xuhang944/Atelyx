/**
 * 多维表格（.atb）运行时状态：当前打开的表格内容 + 防抖保存 + 外部修改冲突。
 *
 * 保存管线对齐 canvasStore：debounce 500ms 原子写 + `markSelfSave` 抑制 watcher 回放 +
 * 乐观锁 `baseUpdatedAt`（磁盘版本更新则拒绝覆盖，冲突提示条由页面层展示）。
 * 窗口槽/恢复/重命名联动由页面层（ProjectWorkspacePage）编排，本 store 只管内容与持久化。
 * title 变更走 `vaultStore.renameTable`（Rust 改文件名 + 同步画布引用），本 store 不直接改 title。
 */
import { create } from "zustand";
import { CALC_TYPES_BY_FIELD, TABLE_SCHEMA } from "@/constants/table";
import {
  exportTableXlsx,
  readExternalImageDataUrl,
  readTableVault,
  writeTableVault,
} from "@/services/table";
import { chatOnce } from "@/services/ai/client";
import { pickFile, saveFile } from "@/services/dialog";
import { markSelfSave } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { parseFillRows } from "@/utils/table";
import type { CalcType, CellValue, FieldType, Message, TableField, TableRow } from "@/types";

/** AI 填行 system 提示词：字段定义内联 + 严格 JSON 数组输出约束。 */
const FILL_ROWS_SYSTEM_PROMPT = `你是表格数据填充助手。根据字段定义与用户提供的对话内容，生成表格行数据。
字段定义（名称、类型、选项）：
{fields}

输出要求：
1. 只输出一个 JSON 数组，每个元素是一个对象，键 = 字段名称，值 = 该字段的值；
2. 文本字段输出字符串；数字/时长字段输出数字（秒）；单选字段只能从选项中选择；
3. 图片字段不输出；
4. 没有合适内容的字段省略该键；
5. 除 JSON 数组外不要输出任何文字。`;

/** 编辑器视图：表格 / 时间线（内存态不持久化）。 */
export type TableView = "table" | "timeline";

/** 表格选中范围（互斥）：单元格 / 整行 / 整列 / 整表；null = 无选中。 */
export type TableSelection =
  | { kind: "cell"; rowId: string; fieldId: string }
  | { kind: "row"; rowId: string }
  | { kind: "column"; fieldId: string }
  | { kind: "all" }
  | null;

/** 覆盖编辑瞬态意图（选中单元格后打字触发；initial = 覆盖初始内容，IME 为 ""）。 */
export interface CellOverwriteTarget {
  rowId: string;
  fieldId: string;
  initial: string;
}

interface TableStoreState {
  /** 当前打开的 .atb 相对仓库根路径（null = 未打开）。 */
  tableFile: string | null;
  id: string;
  title: string;
  fields: TableField[];
  rows: TableRow[];
  /** 乐观并发基准（加载时的磁盘 updatedAt；保存成功后同步为写入版本）。 */
  baseUpdatedAt: number;
  dirty: boolean;
  saving: boolean;
  /** 外部修改 + 本地有未保存改动：冲突提示条由用户决定（重载丢弃本地）。 */
  conflictPending: boolean;
  error: string | null;
  /** 选中行（表格/时间线视图联动；null = 无选中）。 */
  selectedRowId: string | null;
  /** 当前选中范围（单元格/行/列/整表互斥；表格视图高亮用，时间线只读 selectedRowId）。 */
  selection: TableSelection;
  /** 覆盖编辑瞬态意图（打字触发 → TableCell 消费后清除；不持久化）。 */
  overwriteTarget: CellOverwriteTarget | null;
  view: TableView;

  /** 打开表格：读盘填充 + 同步乐观锁基准。失败时 error 提示（文件已删/损坏降级不崩溃）。 */
  load: (file: string) => Promise<void>;
  /** 外部修改后重载磁盘最新内容（无本地改动时 watcher 调用）。 */
  reloadFromDisk: () => Promise<void>;
  /** 冲突处理：keepLocal=true 保留本地并保存（绕过乐观锁覆盖磁盘）；false 重载丢弃本地。 */
  resolveConflict: (keepLocal: boolean) => Promise<void>;
  /** 清空运行时状态（切仓库/关窗口/删除文件时调用：取消保存定时器，防残留 timer 重写已删文件）。 */
  clear: () => void;
  /** 关闭错误提示。 */
  clearError: () => void;
  /** 立即落盘（卸载/切仓库前 flush；无改动不写）。force = 保留本地（绕过乐观锁强制覆盖，冲突条「保留本地并保存」用）。 */
  flush: (force?: boolean) => Promise<boolean>;

  updateCell: (rowId: string, fieldId: string, value: CellValue | undefined) => void;
  /** 图片单元格追加图片（系统文件选择器 → 读 dataURL 内嵌）。 */
  addImageToCell: (rowId: string, fieldId: string) => Promise<void>;
  /** 图片单元格移除指定下标图片。 */
  removeImageAt: (rowId: string, fieldId: string, index: number) => void;
  /** 导出 xlsx：系统保存对话框选目标路径 → 导出当前内容。成功返回 true。 */
  exportXlsx: () => Promise<boolean>;
  /**
   * AI 填行：对话节点右键「生成到表格」——读取目标表字段定义，按对话消息内容
   * 请求 LLM 生成行数据并**追加**到表尾（不清空已有行），成功后表格成为当前打开表。
   * selection = 源对话节点的 {providerId, model}（null = 跟随仓库默认）。
   */
  generateRowsFromConversation: (
    tableFile: string,
    selection: { providerId?: string; model?: string } | null,
    messages: Message[],
  ) => Promise<{ ok: boolean; reason?: string }>;
  addField: (name: string, type: FieldType) => void;
  insertField: (index: number, name: string, type: FieldType) => void;
  renameField: (fieldId: string, name: string) => void;
  retypeField: (fieldId: string, type: FieldType) => void;
  setFieldOptions: (fieldId: string, options: string[]) => void;
  /** 拖拽调整列宽（px，随 .atb 持久化；缺省 = 按字段名自适应）。 */
  setFieldWidth: (fieldId: string, width: number) => void;
  /** 拖拽调整行高（px，随 .atb 持久化；缺省 = 内容自然撑开）。 */
  setRowHeight: (rowId: string, height: number) => void;
  /** 行高自适应：清除手动行高，恢复内容自然撑开。 */
  clearRowHeight: (rowId: string) => void;
  /** 设置状态栏列自动计算类型（缺省 = 无计算）。 */
  setCalcType: (fieldId: string, calcType: CalcType | undefined) => void;
  removeField: (fieldId: string) => void;
  addRow: () => void;
  duplicateRow: (rowId: string) => void;
  removeRow: (rowId: string) => void;
  /** 拖拽插入排序：把 dragId 行移动到 targetIndex 位置（targetIndex = 拖放时原始数组的插入位）。 */
  moveRow: (dragId: string, targetIndex: number) => void;
  /** 选中单元格（同时联动 selectedRowId 供时间线行高亮）。 */
  selectCell: (rowId: string, fieldId: string) => void;
  /** 选中整行（时间线/行首点击共用）。 */
  selectRow: (rowId: string | null) => void;
  /** 选中整列（表头点击）。 */
  selectField: (fieldId: string) => void;
  /** 选中整个表格（左上角点击）。 */
  selectAll: () => void;
  /** 请求目标单元格进入覆盖编辑（清空原值写入 initial；表格视图键盘监听触发）。 */
  triggerOverwrite: (rowId: string, fieldId: string, initial: string) => void;
  /** 消费覆盖意图（TableCell 匹配本单元格后清除）。 */
  clearOverwriteTarget: () => void;
  setView: (view: TableView) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** debounce 500ms 持久化（内容变更后调用；timer 回调里读最新 state）。 */
function schedulePersist(): void {
  const st = useTableStore.getState();
  if (!st.tableFile) return;
  if (saveTimer) clearTimeout(saveTimer);
  useTableStore.setState({ saving: true, dirty: true });
  saveTimer = setTimeout(() => {
    void useTableStore.getState().flush();
  }, 500);
}

export const useTableStore = create<TableStoreState>((set, get) => ({
  tableFile: null,
  id: "",
  title: "",
  fields: [],
  rows: [],
  baseUpdatedAt: 0,
  dirty: false,
  saving: false,
  conflictPending: false,
  error: null,
  selectedRowId: null,
  selection: null,
  overwriteTarget: null,
  view: "table",

  load: async (file) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      const table = await readTableVault(file);
      set({
        tableFile: file,
        id: table.id,
        title: table.title,
        fields: table.fields,
        rows: table.rows,
        baseUpdatedAt: table.updatedAt,
        dirty: false,
        saving: false,
        conflictPending: false,
        error: null,
        selectedRowId: null,
        selection: null,
        overwriteTarget: null,
      });
    } catch (e) {
      console.error("加载表格失败", e);
      // 复位文件态：读失败时上一张表的内容/路径不得残留——继续编辑会写进错误的表文件
      set({
        tableFile: null,
        id: "",
        title: "",
        fields: [],
        rows: [],
        baseUpdatedAt: 0,
        dirty: false,
        saving: false,
        conflictPending: false,
        error: e instanceof Error ? e.message : String(e),
        selectedRowId: null,
        selection: null,
        overwriteTarget: null,
      });
    }
  },

  reloadFromDisk: async () => {
    const file = get().tableFile;
    if (!file) return;
    // load 会清 dirty/冲突并同步乐观锁基准（磁盘即最新）
    await get().load(file);
  },

  resolveConflict: async (keepLocal) => {
    set({ conflictPending: false });
    if (keepLocal) {
      await get().flush(true);
    } else {
      await get().reloadFromDisk();
    }
  },

  clear: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({
      tableFile: null,
      id: "",
      title: "",
      fields: [],
      rows: [],
      baseUpdatedAt: 0,
      dirty: false,
      saving: false,
      conflictPending: false,
      error: null,
      selectedRowId: null,
      selection: null,
      overwriteTarget: null,
    });
  },

  clearError: () => set({ error: null }),

  flush: async (force = false) => {
    const { tableFile, id, title, fields, rows, dirty, baseUpdatedAt } = get();
    // 无脏/未打开：复位 saving（schedulePersist 曾置位但 timer 内无改动可写，防状态卡死）
    if (!tableFile || !dirty) {
      set({ saving: false });
      return false;
    }
    try {
      markSelfSave();
      const updatedAt = await writeTableVault(
        { schema: TABLE_SCHEMA, id, title, fields, rows, createdAt: 0, updatedAt: Date.now() },
        tableFile,
        force ? undefined : baseUpdatedAt,
      );
      // 竞态守卫：await 期间可能已切换表格（load 替换了状态），旧表的写盘结果不得覆盖新表
      // 的乐观锁基准/脏标记（否则新表下次保存被误判冲突、脏编辑被吞）
      if (get().tableFile !== tableFile) return false;
      set({ dirty: false, saving: false, baseUpdatedAt: updatedAt, error: null });
      return true;
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      if (msg.includes("已被外部修改")) {
        // 乐观锁冲突：不覆盖磁盘，提示用户重载（本地改动保留在内存供查看）
        set({ conflictPending: true, saving: false });
      } else {
        console.error("表格自动保存失败", e);
        set({ error: "自动保存失败，请检查磁盘空间或权限", saving: false });
      }
      return false;
    }
  },

  updateCell: (rowId, fieldId, value) => {
    set((s) => ({
      rows: s.rows.map((r) =>
        r.id === rowId
          ? { ...r, values: { ...r.values, [fieldId]: value } }
          : r,
      ),
    }));
    schedulePersist();
  },

  addImageToCell: async (rowId, fieldId) => {
    try {
      const src = await pickFile([{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]);
      if (!src) return;
      const dataUrl = await readExternalImageDataUrl(src);
      const current = get().rows.find((r) => r.id === rowId)?.values[fieldId];
      const list = Array.isArray(current) ? [...current] : [];
      list.push(dataUrl);
      get().updateCell(rowId, fieldId, list);
    } catch (e) {
      console.error("添加图片失败", e);
      set({ error: "添加图片失败，请重试" });
    }
  },

  removeImageAt: (rowId, fieldId, index) => {
    const current = get().rows.find((r) => r.id === rowId)?.values[fieldId];
    if (!Array.isArray(current)) return;
    const list = [...current];
    list.splice(index, 1);
    get().updateCell(rowId, fieldId, list);
  },

  exportXlsx: async () => {
    const { tableFile, id, title, fields, rows, baseUpdatedAt } = get();
    if (!tableFile) return false;
    try {
      const target = await saveFile({
        defaultPath: `${title}.xlsx`,
        filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      });
      if (!target) return false;
      await exportTableXlsx(
        { schema: TABLE_SCHEMA, id, title, fields, rows, createdAt: 0, updatedAt: baseUpdatedAt },
        target,
      );
      return true;
    } catch (e) {
      console.error("导出 xlsx 失败", e);
      set({ error: "导出 xlsx 失败，请重试" });
      return false;
    }
  },

  generateRowsFromConversation: async (tableFile, selection, messages) => {
    // 目标表不是当前打开表：先落盘当前表（防脏编辑丢失）再加载目标表（其字段成为生成基准）
    if (get().tableFile !== tableFile) {
      await get().flush();
      await get().load(tableFile);
      if (get().tableFile !== tableFile) return { ok: false, reason: "读取目标表格失败" };
    }
    const { fields, title } = get();
    if (fields.length === 0) return { ok: false, reason: "目标表格没有字段，请先添加字段" };
    // 模型解析链与对话发送一致：节点指定 → 仓库默认（未配置报错）
    const target = useSettingsStore.getState().resolveChatTarget(selection);
    if (!target.ok) return { ok: false, reason: target.error };
    const fieldLines = fields
      .map((f) => {
        const opts = f.type === "singleSelect" && f.options?.length ? `（选项：${f.options.join("/")}）` : "";
        return `${f.name}：${f.type}${opts}`;
      })
      .join("\n");
    const transcript = messages
      .map((m) => `${m.role === "user" ? "用户" : "AI"}: ${m.content}`)
      .join("\n\n");
    try {
      const raw = await chatOnce({
        baseUrl: target.provider.baseUrl,
        apiKey: target.provider.apiKey,
        model: target.model,
        messages: [
          { role: "system", content: FILL_ROWS_SYSTEM_PROMPT.replace("{fields}", fieldLines) },
          { role: "user", content: `表格名称：${title}\n\n对话内容：\n${transcript}` },
        ],
      });
      const rows = parseFillRows(raw, fields);
      if (rows.length === 0) return { ok: false, reason: "AI 未返回有效行数据，请重试" };
      set((s) => ({ rows: [...s.rows, ...rows] }));
      schedulePersist();
      return { ok: true };
    } catch (e) {
      console.error("AI 填行失败", e);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },

  addField: (name, type) => {
    const field: TableField = { id: crypto.randomUUID(), name: name || "字段", type };
    set((s) => ({ fields: [...s.fields, field] }));
    schedulePersist();
  },

  insertField: (index, name, type) => {
    const field: TableField = { id: crypto.randomUUID(), name: name || "字段", type };
    set((s) => {
      const next = [...s.fields];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, field);
      return { fields: next };
    });
    schedulePersist();
  },

  renameField: (fieldId, name) => {
    set((s) => ({
      fields: s.fields.map((f) => (f.id === fieldId ? { ...f, name: name || f.name } : f)),
    }));
    schedulePersist();
  },

  retypeField: (fieldId, type) => {
    set((s) => ({
      fields: s.fields.map((f) => {
        if (f.id !== fieldId) return f;
        // 改类型后原 calcType 可能不适用（如数字列求和 → 文本列），残留会产生误导统计，一并清除
        const calcType =
          f.calcType && CALC_TYPES_BY_FIELD[type].includes(f.calcType) ? f.calcType : undefined;
        return { ...f, type, calcType };
      }),
    }));
    schedulePersist();
  },

  setFieldOptions: (fieldId, options) => {
    set((s) => ({
      fields: s.fields.map((f) => (f.id === fieldId ? { ...f, options } : f)),
    }));
    schedulePersist();
  },

  setFieldWidth: (fieldId, width) => {
    set((s) => ({
      fields: s.fields.map((f) => (f.id === fieldId ? { ...f, width } : f)),
    }));
    schedulePersist();
  },

  setRowHeight: (rowId, height) => {
    set((s) => ({
      rows: s.rows.map((r) => (r.id === rowId ? { ...r, height } : r)),
    }));
    schedulePersist();
  },

  clearRowHeight: (rowId) => {
    set((s) => ({
      rows: s.rows.map((r) => {
        if (r.id !== rowId) return r;
        const { height: _drop, ...rest } = r;
        return rest;
      }),
    }));
    schedulePersist();
  },

  setCalcType: (fieldId, calcType) => {
    set((s) => ({
      fields: s.fields.map((f) => (f.id === fieldId ? { ...f, calcType } : f)),
    }));
    schedulePersist();
  },

  removeField: (fieldId) => {
    set((s) => {
      // 选中范围指向被删列（单元格/整列）时清空，防高亮残留失效引用
      const sel = s.selection;
      const stale = sel && (sel.kind === "cell" || sel.kind === "column") && sel.fieldId === fieldId;
      return {
        fields: s.fields.filter((f) => f.id !== fieldId),
        // 删除列同时清掉所有行的该列值（防 values 残留孤儿键）
        rows: s.rows.map((r) => {
          const { [fieldId]: _drop, ...rest } = r.values;
          return { ...r, values: rest };
        }),
        selection: stale ? null : s.selection,
      };
    });
    schedulePersist();
  },

  addRow: () => {
    const row: TableRow = { id: crypto.randomUUID(), values: {} };
    set((s) => ({ rows: [...s.rows, row] }));
    schedulePersist();
  },

  duplicateRow: (rowId) => {
    set((s) => {
      const idx = s.rows.findIndex((r) => r.id === rowId);
      if (idx < 0) return {};
      const copy: TableRow = { id: crypto.randomUUID(), values: { ...s.rows[idx].values } };
      const next = [...s.rows];
      next.splice(idx + 1, 0, copy);
      return { rows: next };
    });
    schedulePersist();
  },

  removeRow: (rowId) => {
    set((s) => {
      // 选中范围指向被删行（单元格/整行）时清空，防高亮残留失效引用
      const sel = s.selection;
      const stale = sel && (sel.kind === "cell" || sel.kind === "row") && sel.rowId === rowId;
      return {
        rows: s.rows.filter((r) => r.id !== rowId),
        selectedRowId: s.selectedRowId === rowId ? null : s.selectedRowId,
        selection: stale ? null : s.selection,
      };
    });
    schedulePersist();
  },

  moveRow: (dragId, targetIndex) => {
    const rows = get().rows;
    const from = rows.findIndex((r) => r.id === dragId);
    if (from < 0) return;
    // targetIndex 是拖放时「原始数组」的插入位：移除拖拽行后校正下标
    let insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
    insertAt = Math.max(0, Math.min(insertAt, rows.length - 1));
    if (insertAt === from) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(insertAt, 0, moved);
    set({ rows: next });
    schedulePersist();
  },

  selectCell: (rowId, fieldId) => {
    set({ selection: { kind: "cell", rowId, fieldId }, selectedRowId: rowId });
  },

  selectRow: (rowId) => {
    if (rowId === null) {
      set({ selection: null, selectedRowId: null });
    } else {
      set({ selection: { kind: "row", rowId }, selectedRowId: rowId });
    }
  },

  selectField: (fieldId) => set({ selection: { kind: "column", fieldId }, selectedRowId: null }),

  selectAll: () => set({ selection: { kind: "all" }, selectedRowId: null }),

  triggerOverwrite: (rowId, fieldId, initial) =>
    set({ overwriteTarget: { rowId, fieldId, initial } }),

  clearOverwriteTarget: () => set({ overwriteTarget: null }),

  setView: (view) => set({ view }),
}));
