/**
 * 表格工具纯函数测试（utils/table）。
 *
 * 本轮覆盖历史版本可读化：`diffTableVersions`（字段增删/改名 + 行增删 + 单元格修改 + 顺序）
 * 与 `summarizeTableSnapshot`（人话摘要，列表展示）。
 */
import { describe, it, expect } from "vitest";
import { diffTableVersions, summarizeTableSnapshot } from "./table";
import type { TableField, TableRow } from "@/types";

const field = (id: string, name: string): TableField => ({ id, name, type: "text" });
const row = (id: string, values: Record<string, string>): TableRow => ({ id, values });

/** `.atb` 格式快照（历史存的就是这个形态）。 */
function tableSnap(fields: TableField[], rows: TableRow[]): string {
  return JSON.stringify({
    schema: "atelyx-table/v1",
    id: "t1",
    title: "分镜",
    fields,
    rows,
    createdAt: 0,
    updatedAt: 0,
  });
}

describe("diffTableVersions", () => {
  it("行新增 + 单元格修改（两版共有的字段）", () => {
    const prev = tableSnap(
      [field("f1", "镜号"), field("f2", "状态")],
      [row("r1", { f1: "01", f2: "待拍" })],
    );
    const next = tableSnap(
      [field("f1", "镜号"), field("f2", "状态")],
      [row("r1", { f1: "01", f2: "已拍" }), row("r2", { f1: "02", f2: "待拍" })],
    );
    const d = diffTableVersions(prev, next);
    expect(d.addedRows).toContain("02");
    expect(d.cellChanges).toHaveLength(1);
    expect(d.cellChanges[0]).toMatchObject({ rowIndex: 1, fieldName: "状态", from: "待拍", to: "已拍" });
  });

  it("字段删除单独计入（被删字段里的改动不重复算单元格修改）", () => {
    const prev = tableSnap(
      [field("f1", "镜号"), field("f2", "状态")],
      [row("r1", { f1: "01", f2: "待拍" })],
    );
    const next = tableSnap([field("f1", "镜号")], [row("r1", { f1: "01" })]);
    const d = diffTableVersions(prev, next);
    expect(d.removedFields.map((f) => f.name)).toEqual(["状态"]);
    expect(d.cellChanges).toHaveLength(0);
  });

  it("字段改名与列顺序变化", () => {
    const prev = tableSnap([field("f1", "镜号"), field("f2", "景别")], []);
    const next = tableSnap([field("f2", "景别"), field("f1", "分镜号")], []);
    const d = diffTableVersions(tableSnap([field("f1", "镜号")], []), tableSnap([field("f1", "分镜号")], []));
    expect(d.renamedFields).toEqual([{ from: "镜号", to: "分镜号" }]);
    const d2 = diffTableVersions(prev, next);
    expect(d2.fieldOrderChanged).toBe(true);
  });

  it("首版（prev 空）全部计为新增", () => {
    const d = diffTableVersions("", tableSnap([field("f1", "镜号")], [row("r1", { f1: "01" })]));
    expect(d.addedFields).toHaveLength(1);
    expect(d.addedRows).toHaveLength(1);
    expect(summarizeTableSnapshot("", tableSnap([field("f1", "镜号")], [row("r1", { f1: "01" })]))).toBe(
      "新建 · 1 字段 · 1 行",
    );
  });
});

describe("summarizeTableSnapshot", () => {
  it("新增行 + 修改单元格", () => {
    const prev = tableSnap([field("f1", "镜号"), field("f2", "状态")], [row("r1", { f1: "01", f2: "待拍" })]);
    const next = tableSnap(
      [field("f1", "镜号"), field("f2", "状态")],
      [row("r1", { f1: "01", f2: "已拍" }), row("r2", { f1: "02" })],
    );
    const s = summarizeTableSnapshot(prev, next);
    expect(s).toContain("新增 1 行");
    expect(s).toContain("修改 1 个单元格");
  });

  it("无变化 → 未改动", () => {
    const snap = tableSnap([field("f1", "镜号")], [row("r1", { f1: "01" })]);
    expect(summarizeTableSnapshot(snap, snap)).toBe("未改动");
  });

  it("损坏快照 → 空串（不崩）", () => {
    expect(summarizeTableSnapshot("not-json", "also-not-json")).toBe("");
  });
});
