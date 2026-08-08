/**
 * 表格内容 → 注入文本快照（表格节点摘要展示 / 注入对话上下文共用）。
 *
 * 行限 `MAX_TABLE_INJECT_ROWS`（防超长上下文）；image 值 → `[图 N 张]`；
 * 多行文本压成单行空格（保持注入文本紧凑）；超出行数截断标注。
 */
import { MAX_TABLE_INJECT_ROWS, MAX_COL_WIDTH, MIN_COL_WIDTH } from "@/constants/table";
import type { CellValue, TableField, TableFile, TableRow } from "@/types";

/**
 * 列宽默认值：按字段名称字数自适应（CJK 字符按双宽，每单位 7px + 边距 24px），
 * 钳制在 [MIN_COL_WIDTH, MAX_COL_WIDTH]；用户拖拽调整后存字段 `width` 覆盖。
 */
export function fieldDefaultWidth(name: string): number {
  let units = 0;
  for (const ch of name) {
    units += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, units * 7 + 24));
}

export function tableToSnapshotText(table: TableFile): string {
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
 * 解析 LLM 填行输出为行数据（AI 生成行 → 追加进表格）。
 * 输入 = 模型回复原文：剥 code fence → 截取首个 `[` 到末个 `]` → JSON.parse；
 * 字段按**名称**匹配（大小写敏感），类型强转兜底（number/duration 转数字、singleSelect 保留原串、
 * image 不产出）；未知字段丢弃。解析失败返回空数组（调用方报错重试）。
 */
export function parseFillRows(raw: string, fields: TableField[]): TableRow[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
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
