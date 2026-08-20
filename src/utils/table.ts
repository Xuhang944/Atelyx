/**
 * 表格工具纯函数：列宽自适应、内容快照注入、AI 填行解析、状态栏列自动计算、增量补丁计算、
 * 磁盘/内存内容比对。
 *
 * - `fieldDefaultWidth`：列宽按字段名自适应（CJK 双宽，钳制 [MIN_COL_WIDTH, MAX_COL_WIDTH]）。
 * - `tableToSnapshotText`：表格 → 注入文本快照（行限 `MAX_TABLE_INJECT_ROWS`；image → `[图 N 张]`；
 *   多行文本压单行空格；超行数截断标注）。
 * - `parseFillRows`：LLM 填行输出 → 行数据（剥 code fence → 截 `[`..`]` → JSON.parse，字段按名称
 *   匹配 + 类型强转兜底，image 不产出；失败返回空数组由调用方报错重试）。
 * - `computeColumnCalc`：按字段 calcType 统计全列，返回显示文本（数字统计 / 非空计数）。
 * - `computeTablePatch`：增量补丁计算（保存写盘与协作实时广播共用）。
 * - `tablesEqual`：磁盘表格与内存内容比对（watcher 回放判别）。
 */
import { MAX_TABLE_INJECT_ROWS, MAX_COL_WIDTH, MIN_COL_WIDTH } from "@/constants/table";
import type { CellValue, TableField, TableFile, TablePatch, TableRow } from "@/types";

/** CJK 全角字符（列宽/单元格宽度估算共用口径，双宽判定）。 */
const CJK_WIDTH_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 字符显示宽度单位：CJK 全角 = 2，其余 = 1。 */
function charUnits(ch: string): number {
  return CJK_WIDTH_RE.test(ch) ? 2 : 1;
}

/**
 * 列宽默认值：按字段名称字数自适应（CJK 字符按双宽，每单位 7px + 边距 24px），
 * 钳制在 [MIN_COL_WIDTH, MAX_COL_WIDTH]；用户拖拽调整后存字段 `width` 覆盖。
 */
export function fieldDefaultWidth(name: string): number {
  let units = 0;
  for (const ch of name) {
    units += charUnits(ch);
  }
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, units * 7 + 24));
}

/** 单个单元格内容的估算宽度（与 fieldDefaultWidth 同口径：CJK 双宽 × 7px + 边距 24px）。 */
function cellContentWidth(v: CellValue | undefined): number {
  if (Array.isArray(v)) return 72; // image 缩略图 64px + 边距
  const text = v === undefined || v === null ? "" : String(v);
  let maxUnits = 0;
  for (const line of text.split("\n")) {
    let units = 0;
    for (const ch of line) {
      units += charUnits(ch);
    }
    maxUnits = Math.max(maxUnits, units);
  }
  return maxUnits * 7 + 24;
}

/**
 * 列宽自适应：按该列全部单元格内容估算最大宽度，且不小于字段名宽度（名称自适应为下限），
 * 钳制 [MIN_COL_WIDTH, MAX_COL_WIDTH]；空列结果为字段名宽度（与清除手动宽度等效）。
 * 返回最终宽度，由调用方 `setFieldWidth` 写死持久化（table-fixed 布局需显式宽度）。
 */
export function columnAutoWidth(field: TableField, rows: TableRow[]): number {
  const nameWidth = fieldDefaultWidth(field.name);
  const contentWidth = rows.reduce(
    (acc, r) => Math.max(acc, cellContentWidth(r.values[field.id])),
    0,
  );
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.max(nameWidth, contentWidth)));
}

export function tableToSnapshotText(table: Pick<TableFile, "fields" | "rows">): string {
  const header = `字段：${table.fields.map((f) => f.name).join(" | ")}`;
  const lines: string[] = [header];
  const shown = table.rows.slice(0, MAX_TABLE_INJECT_ROWS);
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i];
    const cells = table.fields.map((f) => {
      const v = row.values[f.id];
      if (Array.isArray(v)) return v.length > 0 ? `[图 ${v.length} 张]` : "";
      if (typeof v === "number") return String(v);
      return (v ?? "").toString().replace(/\s+/g, " ").trim();
    });
    lines.push(`行${i + 1}：${cells.join(" | ")}`);
  }
  if (table.rows.length > MAX_TABLE_INJECT_ROWS) {
    lines.push(`…（共 ${table.rows.length} 行，已截断）`);
  }
  return lines.join("\n");
}

/**
 * 把「字段名 → 值」对象数组强转为表格行（AI 填行/工具参数共用）。
 * 字段按**名称**匹配（大小写敏感），类型强转兜底（number/duration 转数字、singleSelect 保留原串、
 * image 不产出）；未知字段丢弃；无效项（非对象）跳过。
 */
export function coerceRowsJson(parsed: unknown, fields: TableField[]): TableRow[] {
  if (!Array.isArray(parsed)) return [];
  const rows: TableRow[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const values: Record<string, CellValue | undefined> = {};
    for (const f of fields) {
      const v = obj[f.name];
      if (v === undefined || v === null) continue;
      switch (f.type) {
        case "number":
        case "duration": {
          const n = Number(v);
          if (!Number.isNaN(n)) values[f.id] = n;
          break;
        }
        case "text":
        case "singleSelect":
          values[f.id] = String(v);
          break;
        case "image":
          // AI 不产出图片，留空由用户补充
          break;
      }
    }
    rows.push({ id: crypto.randomUUID(), values });
  }
  return rows;
}

/** 单元格是否为「非空值」（count 计算口径；image 按数组非空，text/singleSelect 按非空串）。 */
function isNonEmptyValue(v: CellValue): boolean {
  if (typeof v === "number") return true;
  if (Array.isArray(v)) return v.length > 0;
  return v.trim() !== "";
}

/** 数值显示：整数原样，小数保留两位去尾 0。 */
function formatCalcNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * 状态栏列自动计算：按字段 calcType 对全列取值统计，返回显示文本（未设 calcType 返回 null）。
 * sum/count 无数据时为 0；avg/max/min 无数据时为「—」（避免误导性平均值）。
 */
export function computeColumnCalc(field: TableField, rows: TableRow[]): string | null {
  const type = field.calcType;
  if (!type) return null;
  const values = rows
    .map((r) => r.values[field.id])
    .filter((v): v is CellValue => v !== undefined && v !== null);
  if (type === "count") return formatCalcNumber(values.filter(isNonEmptyValue).length);
  const nums = values.filter((v): v is number => typeof v === "number");
  switch (type) {
    case "sum":
      return formatCalcNumber(nums.reduce((acc, n) => acc + n, 0));
    case "avg":
      return nums.length > 0 ? formatCalcNumber(nums.reduce((a, b) => a + b, 0) / nums.length) : "—";
    case "max":
      return nums.length > 0 ? formatCalcNumber(Math.max(...nums)) : "—";
    case "min":
      return nums.length > 0 ? formatCalcNumber(Math.min(...nums)) : "—";
  }
  return null;
}

// ===== 增量补丁计算（保存写盘 / 协作实时广播共用）=====

/** id 序列是否逐位一致（长度不同即不等）。数组顺序是数组属性，引用 diff 看不见，必须显式比对。 */
export function sameIdSequence(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

/** 按 id 序重排（rank = id → 位置）：未出现在 rank 中的实体（对端并发新增）保持相对顺序置尾。
 * 与 Rust `reorder_by` 同语义；合并产物重排（applyLocalOrder）与远端补丁 order 应用（reorderByIds）共用。 */
export function reorderByRank<T extends { id: string }>(items: T[], rank: ReadonlyMap<string, number>): T[] {
  const known: T[] = [];
  const unknown: T[] = [];
  for (const x of items) {
    (rank.has(x.id) ? known : unknown).push(x);
  }
  known.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...known, ...unknown];
}

/**
 * 计算表格增量补丁：与「上次落盘快照」按引用 diff（store 不可变更新，未变实体引用相同），
 * 只产出变化/新增/删除的字段与行 + 顺序变化（id 序列不同 = 排序变更，须经 order 显式携带，
 * 否则拖拽排序/复制行/左右插列不落盘、协作者不可见）。空补丁返回 null（调用方跳过 IPC/广播）。
 */
export function computeTablePatch(opts: {
  tableId: string;
  fields: TableField[];
  rows: TableRow[];
  lastSaved: { fields: TableField[]; rows: TableRow[] };
}): TablePatch | null {
  const { tableId, fields, rows, lastSaved } = opts;
  // 预建 id → 实体索引代替循环内 .find()（大表 O(R²) → O(N)，每次按键/每次保存都会跑）
  const lastFieldsById = new Map(lastSaved.fields.map((f) => [f.id, f]));
  const lastRowsById = new Map(lastSaved.rows.map((r) => [r.id, r]));
  const upsertFieldIds = new Set<string>();
  for (const f of fields) {
    const ls = lastFieldsById.get(f.id);
    if (!ls || ls !== f) upsertFieldIds.add(f.id);
  }
  const currentFieldIds = new Set(fields.map((f) => f.id));
  const removedFieldIds = lastSaved.fields
    .filter((f) => !currentFieldIds.has(f.id))
    .map((f) => f.id);
  const upsertRowIds = new Set<string>();
  for (const r of rows) {
    const ls = lastRowsById.get(r.id);
    if (!ls || ls !== r) upsertRowIds.add(r.id);
  }
  const currentRowIds = new Set(rows.map((r) => r.id));
  const removedRowIds = lastSaved.rows
    .filter((r) => !currentRowIds.has(r.id))
    .map((r) => r.id);
  const fieldOrderChanged = !sameIdSequence(fields, lastSaved.fields);
  const rowOrderChanged = !sameIdSequence(rows, lastSaved.rows);
  const upsertFields = fields.filter((f) => upsertFieldIds.has(f.id));
  const upsertRows = rows.filter((r) => upsertRowIds.has(r.id));
  if (
    upsertFields.length === 0 &&
    upsertRows.length === 0 &&
    removedFieldIds.length === 0 &&
    removedRowIds.length === 0 &&
    !fieldOrderChanged &&
    !rowOrderChanged
  ) {
    return null;
  }
  return {
    id: tableId,
    upsertFields,
    removedFieldIds,
    upsertRows,
    removedRowIds,
    ...(fieldOrderChanged ? { fieldOrder: fields.map((f) => f.id) } : {}),
    ...(rowOrderChanged ? { rowOrder: rows.map((r) => r.id) } : {}),
  };
}

// ===== 磁盘/内存内容比对（watcher 回放判别）=====

/** 字符串数组相等；空数组与 undefined 视为等价（序列化丢空/缺省键不误判为外部修改）。 */
function stringArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const na = a && a.length > 0 ? a : undefined;
  const nb = b && b.length > 0 ? b : undefined;
  if (na === undefined || nb === undefined) return na === nb;
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (na[i] !== nb[i]) return false;
  }
  return true;
}

/** 单元格值相等（数组按项比较；空数组 ≈ undefined，同 stringArrayEqual 口径）。 */
export function cellValueEqual(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && stringArrayEqual(a, b);
  }
  return a === b;
}

/** 行的「已定义值」映射（显式 undefined 键 ≈ 缺失——序列化时被丢弃，不能当作差异）。 */
function definedValues(r: TableRow): Map<string, CellValue> {
  const m = new Map<string, CellValue>();
  for (const [k, v] of Object.entries(r.values)) {
    if (v !== undefined) m.set(k, v);
  }
  return m;
}

function fieldEqual(a: TableField, b: TableField): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    (a.width ?? undefined) === (b.width ?? undefined) &&
    (a.calcType ?? undefined) === (b.calcType ?? undefined) &&
    stringArrayEqual(a.options, b.options)
  );
}

function rowEqual(a: TableRow, b: TableRow): boolean {
  if (a.id !== b.id || (a.height ?? undefined) !== (b.height ?? undefined)) return false;
  const am = definedValues(a);
  const bm = definedValues(b);
  if (am.size !== bm.size) return false;
  for (const [k, v] of am) {
    if (!bm.has(k) || !cellValueEqual(v, bm.get(k))) return false;
  }
  return true;
}

/**
 * 磁盘表格与内存运行时内容比对（watcher 回放判别）：id 序列逐位一致 + 逐实体结构相等
 * （undefined ≈ 缺省键、options/values 逐项深比，不依赖键序）。一致 = 自写回放或已广播
 * 应用的对端写入 → 跳过重载（保护撤销栈/选中态）；不一致 = 真实外部修改。
 */
export function tablesEqual(
  disk: { fields: TableField[]; rows: TableRow[] },
  memory: { fields: TableField[]; rows: TableRow[] },
): boolean {
  if (!sameIdSequence(disk.fields, memory.fields) || !sameIdSequence(disk.rows, memory.rows)) {
    return false;
  }
  return (
    disk.fields.every((f, i) => fieldEqual(f, memory.fields[i])) &&
    disk.rows.every((r, i) => rowEqual(r, memory.rows[i]))
  );
}

// ===== 历史版本摘要 / diff（表格历史面板可读化）=====

/** 单元格值展示文本（数组 = 图片数；空 → 空；超长截断）。 */
function formatCellValue(v: CellValue | undefined): string {
  if (v === undefined) return "空";
  if (Array.isArray(v)) return v.length ? `图片 ×${v.length}` : "空";
  const s = String(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/** 行展示名：首个非空文本字段值；无 → 空串（调用方兜底「第 N 行」）。 */
function rowLabelOf(row: TableRow, fields: TableField[]): string {
  for (const f of fields) {
    const v = row.values[f.id];
    if (typeof v === "string" && v.trim() !== "") {
      const s = v.trim();
      return s.length > 16 ? `${s.slice(0, 16)}…` : s;
    }
  }
  return "";
}

/** 解析历史快照为 TableFile；空串/损坏 → null。 */
function parseTableSnapshot(raw: string): TableFile | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as TableFile;
    return t && Array.isArray(t.fields) && Array.isArray(t.rows) ? t : null;
  } catch {
    return null;
  }
}

/** 表格历史版本 diff（相对上一版本；首版 prev 为空 → 全部字段/行计为新增）。 */
export interface TableVersionDiff {
  addedFields: { name: string }[];
  removedFields: { name: string }[];
  renamedFields: { from: string; to: string }[];
  addedRows: string[];
  removedRows: string[];
  cellChanges: { rowIndex: number; fieldName: string; from: string; to: string }[];
  fieldOrderChanged: boolean;
  rowOrderChanged: boolean;
}

/** 对比两个历史快照：字段增删/改名 + 行增删 + 单元格修改 + 顺序变化（纯函数，历史面板懒计算）。 */
export function diffTableVersions(prevRaw: string, nextRaw: string): TableVersionDiff {
  const prev = parseTableSnapshot(prevRaw);
  const next = parseTableSnapshot(nextRaw);
  if (!next) {
    return {
      addedFields: [],
      removedFields: [],
      renamedFields: [],
      addedRows: [],
      removedRows: [],
      cellChanges: [],
      fieldOrderChanged: false,
      rowOrderChanged: false,
    };
  }
  const prevFields = prev?.fields ?? [];
  const prevRows = prev?.rows ?? [];
  const prevFieldsById = new Map(prevFields.map((f) => [f.id, f]));
  const prevRowsById = new Map(prevRows.map((r) => [r.id, r]));
  const nextFieldIds = new Set(next.fields.map((f) => f.id));
  const nextRowIds = new Set(next.rows.map((r) => r.id));
  // 行号按 next 版本的实际位置（1-based）；预建 index map 免每行 indexOf（大表 O(R²) → O(N)）
  const nextRowIndex = new Map(next.rows.map((r, i) => [r.id, i]));
  const prevRowIndex = new Map(prevRows.map((r, i) => [r.id, i]));

  const addedFields = next.fields.filter((f) => !prevFieldsById.has(f.id)).map((f) => ({ name: f.name }));
  const removedFields = prevFields.filter((f) => !nextFieldIds.has(f.id)).map((f) => ({ name: f.name }));
  const renamedFields = next.fields
    .filter((f) => {
      const p = prevFieldsById.get(f.id);
      return p && p.name !== f.name;
    })
    .map((f) => ({ from: prevFieldsById.get(f.id)!.name, to: f.name }));

  const addedRows = next.rows
    .filter((r) => !prevRowsById.has(r.id))
    .map((r) => rowLabelOf(r, next.fields) || `第 ${(nextRowIndex.get(r.id) ?? 0) + 1} 行`);
  const removedRows = prevRows
    .filter((r) => !nextRowIds.has(r.id))
    .map((r) => rowLabelOf(r, prevFields) || `第 ${(prevRowIndex.get(r.id) ?? 0) + 1} 行`);

  const cellChanges: TableVersionDiff["cellChanges"] = [];
  for (const r of next.rows) {
    const p = prevRowsById.get(r.id);
    if (!p) continue;
    const rowIndex = (nextRowIndex.get(r.id) ?? 0) + 1;
    for (const f of next.fields) {
      if (!cellValueEqual(p.values[f.id], r.values[f.id])) {
        cellChanges.push({
          rowIndex,
          fieldName: f.name,
          from: formatCellValue(p.values[f.id]),
          to: formatCellValue(r.values[f.id]),
        });
      }
    }
  }

  return {
    addedFields,
    removedFields,
    renamedFields,
    addedRows,
    removedRows,
    cellChanges,
    fieldOrderChanged: !sameIdSequence(next.fields, prevFields),
    rowOrderChanged: !sameIdSequence(next.rows, prevRows),
  };
}

/**
 * 历史版本人话摘要（记录时生成，列表展示）：对比上一版本快照输出「新增/删除 N 行 · 修改 N 个
 * 单元格 · 字段增删/改名 · 调整顺序」；无上一版本 = 新建统计。空表/损坏快照 → 空串。
 */
export function summarizeTableSnapshot(prevRaw: string, nextRaw: string): string {
  const next = parseTableSnapshot(nextRaw);
  if (!next) return "";
  if (!parseTableSnapshot(prevRaw)) return `新建 · ${next.fields.length} 字段 · ${next.rows.length} 行`;
  const diff = diffTableVersions(prevRaw, nextRaw);
  const parts: string[] = [];
  if (diff.addedRows.length) parts.push(`新增 ${diff.addedRows.length} 行`);
  if (diff.removedRows.length) parts.push(`删除 ${diff.removedRows.length} 行`);
  if (diff.cellChanges.length) parts.push(`修改 ${diff.cellChanges.length} 个单元格`);
  if (diff.addedFields.length) parts.push(`新增字段 ${diff.addedFields.map((f) => `「${f.name}」`).join("、")}`);
  if (diff.removedFields.length) parts.push(`删除字段 ${diff.removedFields.map((f) => `「${f.name}」`).join("、")}`);
  if (diff.renamedFields.length) parts.push(`字段改名 ${diff.renamedFields.map((f) => `「${f.from}」→「${f.to}」`).join("、")}`);
  if (diff.fieldOrderChanged) parts.push("调整列顺序");
  if (diff.rowOrderChanged) parts.push("调整行顺序");
  return parts.length ? parts.join(" · ") : "未改动";
}
