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
  it("自上次落盘后改过正文 → keep（保留本地编辑，LWW）", () => {
    expect(decideTextNodeRefresh("B", "A")).toBe("keep");
  });

  it("saved === current（未编辑过，或内容已回退到已存值）→ refresh（外部/AI 写入，刷到磁盘最新）", () => {
    expect(decideTextNodeRefresh("A", "A")).toBe("refresh");
    expect(decideTextNodeRefresh("B", "B")).toBe("refresh");
  });

  it("新建未落盘节点（saved 缺失）→ refresh 到磁盘最新", () => {
    expect(decideTextNodeRefresh("A", undefined)).toBe("refresh");
  });
});
