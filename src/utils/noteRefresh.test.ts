/**
 * 文本节点正文刷新判定契约测试（utils/noteRefresh）。
 *
 * 核心回归：AI 文件写入（writeVaultFile 登记 lastWrittenMd 基线）不能被当作自写回波跳过，
 * 未编辑过的节点必须刷新到磁盘最新（否则下次画布保存把旧正文回写覆盖 Agent 编辑）；
 * 自上次落盘后改过正文的节点，仅当磁盘仍停在节点基线时保留本地编辑（LWW，防丢字竞态）；
 * 磁盘已前进到节点基线之后 → 外部最新者胜，刷新到磁盘（防陈旧基线上的编辑回写覆盖
 * 笔记编辑器/AI 的新内容——笔记编辑器静默回退的根因）。
 */
import { describe, expect, it } from "vitest";
import { decideTextNodeRefresh } from "./noteRefresh";

describe("decideTextNodeRefresh", () => {
  it("自上次落盘后改过正文且磁盘仍停在基线 → keep（保留本地编辑，LWW）", () => {
    // saved=B 是节点基线，磁盘仍为 B：本地编辑 C 基于当前磁盘，保留
    expect(decideTextNodeRefresh("C", "B", "B")).toBe("keep");
  });

  it("自上次落盘后改过正文但磁盘已前进 → refresh（外部最新者胜，丢弃陈旧基线编辑）", () => {
    // 节点基线 B，磁盘已被其它编辑面推进到 D：本地编辑 C 基于陈旧基线，刷新到磁盘
    expect(decideTextNodeRefresh("C", "B", "D")).toBe("refresh");
  });

  it("saved === current（未编辑过，或内容已回退到已存值）→ refresh（外部/AI 写入，刷到磁盘最新）", () => {
    expect(decideTextNodeRefresh("A", "A", "B")).toBe("refresh");
    expect(decideTextNodeRefresh("B", "B", "C")).toBe("refresh");
  });

  it("新建未落盘节点（saved 缺失）→ refresh 到磁盘最新", () => {
    expect(decideTextNodeRefresh("A", undefined, "B")).toBe("refresh");
  });
});
