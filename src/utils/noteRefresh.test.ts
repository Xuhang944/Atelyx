/**
 * 文本节点正文刷新判定契约测试（utils/noteRefresh）。
 *
 * 核心回归：AI 文件写入（writeVaultFile 登记 lastWrittenMd 基线）不能被当作自写回波跳过，
 * 未编辑过的节点必须刷新到磁盘最新（否则下次画布保存把旧正文回写覆盖 Agent 编辑）；
 * 自上次落盘后改过正文的节点保留本地编辑（LWW，防丢字竞态）。
 */
import { describe, expect, it } from "vitest";
import { decideTextNodeRefresh } from "./noteRefresh";

describe("decideTextNodeRefresh", () => {
  it("节点正文已与磁盘一致 → consistent（无操作，与是否编辑过无关）", () => {
    expect(decideTextNodeRefresh("A", "A", "A")).toBe("consistent");
    expect(decideTextNodeRefresh("A", "B", "A")).toBe("consistent");
  });

  it("自上次落盘后改过正文且磁盘不同 → keep（保留本地编辑，LWW）", () => {
    expect(decideTextNodeRefresh("B", "A", "C")).toBe("keep");
  });

  it("未编辑过（saved === current）且磁盘更新 → refresh（外部/AI 写入，刷到磁盘最新）", () => {
    expect(decideTextNodeRefresh("A", "A", "C")).toBe("refresh");
  });

  it("改回上次落盘内容后磁盘更新 → 按未编辑处理 refresh（内容已回退到已存状态，无丢失）", () => {
    expect(decideTextNodeRefresh("A", "A", "B")).toBe("refresh");
  });

  it("新建未落盘节点（saved 缺失）磁盘更新 → refresh 到磁盘最新", () => {
    expect(decideTextNodeRefresh("A", undefined, "C")).toBe("refresh");
  });
});
