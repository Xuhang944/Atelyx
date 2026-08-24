/**
 * 表格工具纯函数测试（utils/table）。
 *
 * 本轮覆盖历史版本可读化：`diffTableVersions`（字段增删/改名 + 行增删 + 单元格修改 + 顺序）
 * 与 `summarizeTableSnapshot`（人话摘要，列表展示）。
 */
import { describe, it, expect } from "vitest";
import { diffTableVersions, summarizeTableSnapshot, tablesEqual } from "./table";
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

describe("tablesEqual（watcher 回放判别：磁盘 vs 内存）", () => {
  const fields = [field("f1", "镜号"), field("f2", "状态")];
  const rows = [row("r1", { f1: "01", f2: "待拍" })];

  it("一致 → true（自写回放/已广播应用的对端写入，跳过重载）", () => {
    expect(tablesEqual({ fields, rows }, { fields, rows })).toBe(true);
  });

  it("磁盘落后于内存（对端陈旧保存缺最新单元格）→ false——这正是协作闪烁的触发条件，watcher 靠协作对端守卫跳过重载", () => {
    // 内存已应用对端广播（f2 已改为「已拍」），磁盘还是对端保存捕获的旧值（「待拍」）
    const disk = { fields, rows: [row("r1", { f1: "01", f2: "待拍" })] };
    const memory = { fields, rows: [row("r1", { f1: "01", f2: "已拍" })] };
    expect(tablesEqual(disk, memory)).toBe(false);
  });

  it("磁盘新于内存（漏收广播/外部修改新增单元格）→ false——仍需重载收敛", () => {
    const disk = { fields, rows: [row("r1", { f1: "01", f2: "已拍" })] };
    const memory = { fields, rows: [row("r1", { f1: "01", f2: "待拍" })] };
    expect(tablesEqual(disk, memory)).toBe(false);
  });

  it("行序变化 → false（顺序是数组属性，引用 diff 不可见，须显式比对）", () => {
    const disk = { fields, rows: [row("r2", { f1: "02" }), row("r1", { f1: "01" })] };
    const memory = { fields, rows: [row("r1", { f1: "01" }), row("r2", { f1: "02" })] };
    expect(tablesEqual(disk, memory)).toBe(false);
  });

  it("undefined 键 ≈ 缺失键 → true（序列化丢空/缺省键不误判为外部修改）", () => {
    const disk = { fields, rows: [{ id: "r1", values: { f1: "01", f2: undefined } }] };
    const memory = { fields, rows: [row("r1", { f1: "01" })] };
    expect(tablesEqual(disk, memory)).toBe(true);
  });

  it("行高/列宽缺省 ≈ 显式 undefined → true；实际不同 → false", () => {
    const disk = { fields, rows: [{ id: "r1", values: { f1: "01" }, height: 40 }] };
    const memory = { fields, rows: [{ id: "r1", values: { f1: "01" } }] };
    expect(tablesEqual(disk, memory)).toBe(false);
    const disk2 = { fields: [field("f1", "镜号")], rows: [] };
    const memory2 = { fields: [{ ...field("f1", "镜号"), width: undefined }], rows: [] };
    expect(tablesEqual(disk2, memory2)).toBe(true);
  });
});
