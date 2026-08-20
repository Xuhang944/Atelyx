/**
 * 通用历史服务契约测试。
 *
 * - 侧文件路径：note 保持旧路径向后兼容，canvas/table 分目录摊平。
 * - 版本管理：追加 seq、同内容去重、同作者连续编辑 60s 合并（滑动更新）。
 * - 作者门控：Agent 写入（`authorOverride`）不与用户版本串版；Agent 连续写入才合并。
 * - `recordAgentFileWrite`：跳过 `.atelyx/` 隐藏目录、按扩展名定 kind、content 缺省读回。
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

// 内存文件 I/O mock（历史侧文件读写走 services/vault/aiFiles；Tauri invoke 在测试环境不可用）
const { memory } = vi.hoisted(() => ({
  memory: new Map<string, string>(),
}));
vi.mock("@/services/vault/aiFiles", () => ({
  readVaultFile: (file: string) => {
    const v = memory.get(file);
    return v === undefined
      ? Promise.reject(new Error(`not found: ${file}`))
      : Promise.resolve(v);
  },
  writeVaultFile: (file: string, content: string) => {
    memory.set(file, content);
    return Promise.resolve();
  },
}));

import {
  historyPathFor,
  setHistoryAuthor,
  loadHistory,
  recordHistoryVersion,
  recordAgentFileWrite,
  AGENT_AUTHOR,
  versionContentAt,
} from "./index";

const F = "notes/a.md";
const CANVAS = "c/方案.atlx";
const TABLE = "t/分镜.atb";

beforeEach(() => {
  memory.clear();
  setHistoryAuthor({ id: "dev-1", name: "张三", device: "dev-1" });
});

describe("historyPathFor", () => {
  it("note 保持旧路径向后兼容", () => {
    expect(historyPathFor("note", F)).toBe(`.atelyx/history/${encodeURIComponent(F)}.json`);
  });
  it("canvas/table 按 kind 分目录", () => {
    expect(historyPathFor("canvas", CANVAS)).toBe(
      `.atelyx/history/canvas/${encodeURIComponent(CANVAS)}.json`,
    );
    expect(historyPathFor("table", TABLE)).toBe(
      `.atelyx/history/table/${encodeURIComponent(TABLE)}.json`,
    );
  });
});

describe("recordHistoryVersion / loadHistory", () => {
  it("追加版本并递增 seq、作者为当前用户", async () => {
    await recordHistoryVersion("note", F, { content: "v1", action: "edit" });
    await recordHistoryVersion("note", F, { content: "v2", action: "edit" });
    const vs = await loadHistory("note", F);
    expect(vs.map((v) => v.seq)).toEqual([1, 2]);
    expect(vs[1].author.name).toBe("张三");
  });

  it("内容 + 行为相同 no-op 去重", async () => {
    await recordHistoryVersion("note", F, { content: "v1", action: "edit" });
    await recordHistoryVersion("note", F, { content: "v1", action: "edit" });
    expect((await loadHistory("note", F)).length).toBe(1);
  });

  it("同作者连续编辑 60s 内合并为一版（滑动更新到最新）", async () => {
    await recordHistoryVersion("note", F, { content: "v1", action: "edit", coalesceEditMs: 60_000 });
    await recordHistoryVersion("note", F, { content: "v2", action: "edit", coalesceEditMs: 60_000 });
    const vs = await loadHistory("note", F);
    expect(vs.length).toBe(1);
    expect(vs[0].content).toBe("v2");
  });

  it("Agent 写入不与用户版本串版（作者不同不合并）", async () => {
    await recordHistoryVersion("note", F, { content: "user1", action: "edit", coalesceEditMs: 60_000 });
    await recordHistoryVersion("note", F, {
      content: "agent1",
      action: "edit",
      coalesceEditMs: 60_000,
      authorOverride: AGENT_AUTHOR,
    });
    const vs = await loadHistory("note", F);
    expect(vs.length).toBe(2);
    expect(vs[1].author.id).toBe("ai-agent");
  });

  it("Agent 连续写入合并、恢复用户编辑后再开新版本", async () => {
    await recordHistoryVersion("note", F, {
      content: "a1",
      action: "edit",
      coalesceEditMs: 60_000,
      authorOverride: AGENT_AUTHOR,
    });
    await recordHistoryVersion("note", F, {
      content: "a2",
      action: "edit",
      coalesceEditMs: 60_000,
      authorOverride: AGENT_AUTHOR,
    });
    expect((await loadHistory("note", F)).length).toBe(1);
    await recordHistoryVersion("note", F, { content: "user", action: "edit", coalesceEditMs: 60_000 });
    expect((await loadHistory("note", F)).length).toBe(2);
  });

  it("versionContentAt 按 seq 取快照", async () => {
    await recordHistoryVersion("canvas", CANVAS, { content: "{}", action: "edit" });
    const vs = await loadHistory("canvas", CANVAS);
    expect(versionContentAt(vs, 1)).toBe("{}");
    expect(versionContentAt(vs, 99)).toBeNull();
  });

  it("表格单元格存档点（recordTableHistory 同款内存快照）可记录并读回", async () => {
    // 模拟 tableStore.recordTableHistory：以内存 fields/rows 构建 `.atb` 格式快照
    const snapshot = {
      schema: "atelyx-table/v1",
      id: "tbl-1",
      title: "分镜",
      fields: [{ id: "f1", name: "镜号", fieldType: "text" }],
      rows: [{ id: "r1", values: { f1: "01" } }],
      createdAt: 0,
      updatedAt: 1700000000,
    };
    await recordHistoryVersion("table", TABLE, {
      content: JSON.stringify(snapshot),
      action: "edit",
      coalesceEditMs: 60_000,
    });
    const vs = await loadHistory("table", TABLE);
    expect(vs.length).toBe(1);
    const parsed = JSON.parse(vs[0].content) as {
      schema: string;
      title: string;
      fields: unknown[];
      rows: unknown[];
    };
    expect(parsed.schema).toBe("atelyx-table/v1");
    expect(parsed.title).toBe("分镜");
    expect(Array.isArray(parsed.fields) && parsed.fields.length).toBe(1);
    expect(Array.isArray(parsed.rows) && parsed.rows.length).toBe(1);
  });
});

describe("recordAgentFileWrite", () => {
  it("跳过 .atelyx/ 隐藏目录（防历史自身写递归/噪声）", async () => {
    await recordAgentFileWrite(".atelyx/history/x.json", "x");
    expect(await loadHistory("note", ".atelyx/history/x.json")).toEqual([]);
  });

  it("按扩展名定 kind 并以 Agent 身份记录", async () => {
    await recordAgentFileWrite(CANVAS, '{"schema":"atelyx-canvas/v1"}');
    const vs = await loadHistory("canvas", CANVAS);
    expect(vs.length).toBe(1);
    expect(vs[0].author.id).toBe("ai-agent");
    expect(vs[0].action).toBe("edit");
  });

  it("content 缺省读回磁盘（edit_file 场景）", async () => {
    memory.set(TABLE, '{"schema":"atelyx-table/v1"}');
    await recordAgentFileWrite(TABLE);
    const vs = await loadHistory("table", TABLE);
    expect(vs.length).toBe(1);
    expect(vs[0].content).toBe('{"schema":"atelyx-table/v1"}');
  });
});
