/**
 * 插件市场数据源纯逻辑测试（services/plugins/market）。
 *
 * 覆盖：官方账号判定、徽标合并（官方/认可/repo 或 id 命中）、缓存过期判定。
 * fetch/缓存读写（网络 + localStorage）不在本测试覆盖。
 */
import { describe, it, expect } from "vitest";
import { badgeFor, isMarketStale, isOfficialRepo } from "./market";

describe("market 纯逻辑", () => {
  it("官方账号判定", () => {
    expect(isOfficialRepo("atelyx/plugins")).toBe(true);
    expect(isOfficialRepo("someone/plugins")).toBe(false);
  });

  it("徽标：官方账号 → official；认可表命中（repo 或 id）→ endorsed", () => {
    const endorsed = new Set(["com.good.plugin", "nice/repo"]);
    expect(badgeFor({ repo: "atelyx/x", id: "a" }, endorsed)).toBe("official");
    expect(badgeFor({ repo: "nice/repo", id: "b" }, endorsed)).toBe("endorsed");
    expect(badgeFor({ repo: "other/repo", id: "com.good.plugin" }, endorsed)).toBe("endorsed");
    expect(badgeFor({ repo: "other/repo", id: "c" }, endorsed)).toBeUndefined();
  });

  it("缓存过期判定（6h 窗口）", () => {
    expect(isMarketStale(0)).toBe(true);
    expect(isMarketStale(Date.now())).toBe(false);
    expect(isMarketStale(Date.now() - 7 * 60 * 60 * 1000)).toBe(true);
  });
});
