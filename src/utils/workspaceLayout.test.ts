/**
 * 工作区布局树操作契约测试（utils/workspaceLayout）。
 *
 * 覆盖：标签组操作（增删/激活/锁定/排序）、分割/关闭、撕裂/停靠、撕裂窗口操作、
 * 旧 schema 迁移（view 字段 → 标签组）、全局视图唯一与宿主判定、布局复制 id 重生成。
 */
import { describe, expect, it } from "vitest";
import {
  addTabToArea,
  closeArea,
  collectAllViews,
  collectAreas,
  collectTabs,
  collectViewsInTree,
  detachedAddTab,
  detachedMoveTab,
  detachedRemoveTab,
  detachedSetActive,
  detachedSetBounds,
  detachedSetLocked,
  findTabInDetached,
  findTabInTree,
  findViewHost,
  migrateLegacyTree,
  moveTabWithinArea,
  parentSplitOf,
  regenerateIds,
  removeTabFromArea,
  setActiveTab,
  setTabLocked,
  splitArea,
  tearOffFromArea,
} from "./workspaceLayout";
import {
  createArea,
  createTab,
  type DetachedWindow,
  type LayoutNode,
  type SplitNode,
} from "@/types/workspaceLayout";

function makeArea(views: string[], active = 0): LayoutNode {
  const area = createArea(views[0] as never);
  for (let i = 1; i < views.length; i++) {
    // 直接构造多标签面积（避免依赖被测试函数本身）
    area.tabs.push(createTab(views[i] as never));
  }
  area.activeTabId = area.tabs[active]?.id ?? area.tabs[0]?.id ?? null;
  return area;
}

describe("标签组基础操作", () => {
  it("addTabToArea 插入尾部并激活", () => {
    const tree = makeArea(["canvas", "note"]);
    const area = collectAreas(tree)[0];
    const tab = createTab("table");
    const next = addTabToArea(tree, area!.id, tab);
    const nextArea = collectAreas(next)[0];
    expect(nextArea!.tabs.map((t) => t.view)).toEqual(["canvas", "note", "table"]);
    expect(nextArea!.activeTabId).toBe(tab.id);
  });

  it("addTabToArea 支持指定插入位置", () => {
    const tree = makeArea(["canvas", "table"]);
    const area = collectAreas(tree)[0];
    const tab = createTab("note");
    const next = addTabToArea(tree, area!.id, tab, 1);
    expect(collectAreas(next)[0]!.tabs.map((t) => t.view)).toEqual(["canvas", "note", "table"]);
  });

  it("removeTabFromArea 移除非激活标签不动激活位", () => {
    const tree = makeArea(["canvas", "note", "table"], 1);
    const area = collectAreas(tree)[0];
    const next = removeTabFromArea(tree, area!.id, area!.tabs[0]!.id);
    const nextArea = collectAreas(next)[0];
    expect(nextArea!.tabs.map((t) => t.view)).toEqual(["note", "table"]);
    expect(nextArea!.activeTabId).toBe(area!.tabs[1]!.id);
  });

  it("removeTabFromArea 移除激活标签时激活右邻（VS Code 语义）", () => {
    const tree = makeArea(["canvas", "note", "table"], 0);
    const area = collectAreas(tree)[0];
    const next = removeTabFromArea(tree, area!.id, area!.tabs[0]!.id);
    const nextArea = collectAreas(next)[0];
    expect(nextArea!.activeTabId).toBe(area!.tabs[1]!.id);
  });

  it("removeTabFromArea 移除最后一个标签 → 空面积（保留在树中）", () => {
    const tree = makeArea(["canvas"]);
    const area = collectAreas(tree)[0];
    const next = removeTabFromArea(tree, area!.id, area!.tabs[0]!.id);
    const nextArea = collectAreas(next)[0];
    expect(nextArea!.tabs).toEqual([]);
    expect(nextArea!.activeTabId).toBeNull();
    expect(collectAreas(next)).toHaveLength(1);
  });

  it("setActiveTab / setTabLocked", () => {
    const tree = makeArea(["canvas", "note"]);
    const area = collectAreas(tree)[0];
    const locked = setTabLocked(tree, area!.id, area!.tabs[1]!.id, true);
    expect(collectAreas(locked)[0]!.tabs[1]!.locked).toBe(true);
    const activated = setActiveTab(locked, area!.id, area!.tabs[1]!.id);
    expect(collectAreas(activated)[0]!.activeTabId).toBe(area!.tabs[1]!.id);
  });

  it("moveTabWithinArea 组内排序（toIndex = 插入点下标）", () => {
    const tree = makeArea(["a", "b", "c"]);
    const area = collectAreas(tree)[0];
    // 后移：a 拖到 b、c 之间（插入点 2）→ [b, a, c]
    const moved = moveTabWithinArea(tree, area!.id, area!.tabs[0]!.id, 2);
    expect(collectAreas(moved)[0]!.tabs.map((t) => t.view)).toEqual(["b", "a", "c"]);
    // 拖到末尾（插入点 3）→ [b, c, a]
    const end = moveTabWithinArea(moved, area!.id, area!.tabs[0]!.id, 3);
    expect(collectAreas(end)[0]!.tabs.map((t) => t.view)).toEqual(["b", "c", "a"]);
    // 前移：a 从末尾拖回开头（插入点 0）
    const back = moveTabWithinArea(end, area!.id, collectAreas(end)[0]!.tabs[2]!.id, 0);
    expect(collectAreas(back)[0]!.tabs.map((t) => t.view)).toEqual(["a", "b", "c"]);
  });
});

describe("分割 / 关闭", () => {
  it("根面积分割 → 嵌套回退（面积 → Split[原面积, 新空面积]），均分", () => {
    const tree = makeArea(["canvas", "note"]);
    const area = collectAreas(tree)[0];
    const { tree: next, newAreaId } = splitArea(tree, area!.id, "horizontal");
    const areas = collectAreas(next);
    expect(areas).toHaveLength(2);
    expect(areas[0]!.tabs.map((t) => t.view)).toEqual(["canvas", "note"]);
    expect(areas[1]!.tabs).toEqual([]);
    expect(areas[1]!.id).toBe(newAreaId);
  });

  it("closeArea 合并到兄弟（兄弟顶替）；根面积不可关闭", () => {
    const tree = makeArea(["canvas"]);
    expect(closeArea(tree, collectAreas(tree)[0]!.id)).toBeNull();
    const { tree: split } = splitArea(tree, collectAreas(tree)[0]!.id, "horizontal");
    const areas = collectAreas(split);
    const closed = closeArea(split, areas[1]!.id);
    expect(collectAreas(closed!)).toHaveLength(1);
    expect(collectAreas(closed!)[0]!.tabs.map((t) => t.view)).toEqual(["canvas"]);
  });
});

describe("多叉同级分割（左中右）", () => {
  const trio = (): LayoutNode => ({
    kind: "split",
    id: "s1",
    direction: "horizontal",
    children: [createArea("files"), createArea("canvas"), createArea("inspector")],
    sizes: [30, 40, 30],
  });

  it("父方向匹配 → 同级插入到目标面积后，尺寸从相邻面积均分", () => {
    const tree = trio();
    const target = collectAreas(tree)[1]!; // canvas
    const { tree: next, newAreaId } = splitArea(tree, target.id, "horizontal", "after");
    const areas = collectAreas(next);
    expect(areas.map((a) => a.id)).toEqual([
      collectAreas(tree)[0]!.id,
      target.id,
      newAreaId,
      collectAreas(tree)[2]!.id,
    ]);
    const split = next as SplitNode;
    expect(split.sizes).toEqual([30, 20, 20, 30]);
  });

  it("before 插入到目标面积前", () => {
    const tree = trio();
    const target = collectAreas(tree)[1]!;
    const { tree: next, newAreaId } = splitArea(tree, target.id, "horizontal", "before");
    const areas = collectAreas(next);
    expect(areas.map((a) => a.id)).toEqual([
      collectAreas(tree)[0]!.id,
      newAreaId,
      target.id,
      collectAreas(tree)[2]!.id,
    ]);
    expect((next as SplitNode).sizes).toEqual([30, 20, 20, 30]);
  });

  it("父方向不匹配 → 嵌套回退（面积 → 垂直 Split[原面积, 新面积]）", () => {
    const tree = trio();
    const target = collectAreas(tree)[1]!;
    const { tree: next, newAreaId } = splitArea(tree, target.id, "vertical", "after");
    // 树变 [files, [canvas | new], inspector]：外层 3 面积变 2 子树（canvas 被包裹）
    const areas = collectAreas(next);
    expect(areas.map((a) => a.id)).toEqual([
      collectAreas(tree)[0]!.id,
      target.id,
      newAreaId,
      collectAreas(tree)[2]!.id,
    ]);
    expect(areas).toHaveLength(4);
  });

  it("closeArea 多叉移除中间面积：剩 2 个时尺寸归一化到 100", () => {
    const tree = trio();
    const target = collectAreas(tree)[1]!;
    const closed = closeArea(tree, target.id);
    expect(closed!.kind).toBe("split");
    const split = closed as SplitNode;
    expect(collectAreas(split).map((a) => a.id)).toEqual([
      collectAreas(tree)[0]!.id,
      collectAreas(tree)[2]!.id,
    ]);
    expect(split.sizes).toEqual([50, 50]);
  });

  it("closeArea 移除后剩 1 个 → 父塌缩（唯一子节点顶替）", () => {
    const tree: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      children: [createArea("files"), createArea("canvas")],
      sizes: [40, 60],
    };
    const target = collectAreas(tree)[1]!;
    const closed = closeArea(tree, target.id);
    expect(closed!.kind).toBe("area");
    expect((closed as ReturnType<typeof createArea>).tabs.map((t) => t.view)).toEqual(["files"]);
  });

  it("parentSplitOf 定位父 split 与下标", () => {
    const tree = trio();
    const target = collectAreas(tree)[2]!;
    const hit = parentSplitOf(tree, target.id);
    expect(hit?.split.id).toBe("s1");
    expect(hit?.index).toBe(2);
    expect(parentSplitOf(tree, "missing")).toBeNull();
    // 根面积无父
    expect(parentSplitOf(createArea("files"), createArea("files").id)).toBeNull();
  });
});

describe("撕裂 / 停靠", () => {
  it("tearOffFromArea 移除标签（面积留空）并返回标签", () => {
    const tree = makeArea(["canvas", "note"]);
    const area = collectAreas(tree)[0];
    const hit = tearOffFromArea(tree, area!.id, area!.tabs[0]!.id);
    expect(hit).not.toBeNull();
    expect(hit!.tab.view).toBe("canvas");
    expect(collectAreas(hit!.tree)[0]!.tabs.map((t) => t.view)).toEqual(["note"]);
  });

  it("tearOffFromArea 最后一个标签撕裂后面积留空", () => {
    const tree = makeArea(["canvas"]);
    const area = collectAreas(tree)[0];
    const hit = tearOffFromArea(tree, area!.id, area!.tabs[0]!.id);
    expect(hit).not.toBeNull();
    expect(collectAreas(hit!.tree)[0]!.tabs).toEqual([]);
  });
});

describe("撕裂窗口操作", () => {
  const win = (views: string[]): DetachedWindow => {
    const tabs = views.map((v) => createTab(v as never));
    return { id: "w1", tabs, activeTabId: tabs[0]?.id ?? null, bounds: { x: 0, y: 0, width: 420, height: 560 } };
  };

  it("detachedAddTab 插入并激活", () => {
    const w = win(["canvas"]);
    const tab = createTab("note");
    const next = detachedAddTab([w], "w1", tab);
    expect(next[0]!.tabs.map((t) => t.view)).toEqual(["canvas", "note"]);
    expect(next[0]!.activeTabId).toBe(tab.id);
  });

  it("detachedRemoveTab 激活邻居；最后标签移除后窗口保留（空窗口由调用方回收）", () => {
    const w = win(["canvas", "note", "table"]);
    const next = detachedRemoveTab([w], "w1", w.tabs[0]!.id);
    expect(next[0]!.activeTabId).toBe(w.tabs[1]!.id);
    const single = win(["canvas"]);
    const emptied = detachedRemoveTab([single], "w1", single.tabs[0]!.id);
    expect(emptied[0]!.tabs).toEqual([]);
    expect(emptied[0]!.activeTabId).toBeNull();
  });

  it("detachedMoveTab / detachedSetLocked / detachedSetActive / detachedSetBounds", () => {
    const w = win(["a", "b", "c"]);
    const moved = detachedMoveTab([w], "w1", w.tabs[2]!.id, 0);
    expect(moved[0]!.tabs.map((t) => t.view)).toEqual(["c", "a", "b"]);
    const locked = detachedSetLocked(moved, "w1", moved[0]!.tabs[0]!.id, true);
    expect(locked[0]!.tabs[0]!.locked).toBe(true);
    const active = detachedSetActive(locked, "w1", moved[0]!.tabs[1]!.id);
    expect(active[0]!.activeTabId).toBe(moved[0]!.tabs[1]!.id);
    const bounds = detachedSetBounds(active, "w1", { x: 10, y: 20, width: 500, height: 600 });
    expect(bounds[0]!.bounds).toEqual({ x: 10, y: 20, width: 500, height: 600 });
  });

  it("detachedSetBounds 未命中窗口返回原数组（引用稳定）", () => {
    const w = win(["a"]);
    const arr = [w];
    const next = detachedSetBounds(arr, "missing", { x: 0, y: 0, width: 1, height: 1 });
    expect(next).toBe(arr);
  });
});

describe("视图唯一与宿主判定", () => {
  it("collectAllViews 汇总树 + 撕裂窗口视图", () => {
    const tree = makeArea(["canvas", "note"]);
    const w: DetachedWindow = {
      id: "w1",
      tabs: [createTab("table")],
      activeTabId: null,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
    expect(collectAllViews(tree, [w])).toEqual(["canvas", "note", "table"]);
  });

  it("findViewHost：树内 = main；撕裂窗口 = 窗口 id；未渲染 = null", () => {
    const tree = makeArea(["canvas"]);
    const w: DetachedWindow = {
      id: "w1",
      tabs: [createTab("table")],
      activeTabId: null,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
    expect(findViewHost(tree, [w], "canvas")).toBe("main");
    expect(findViewHost(tree, [w], "table")).toBe("w1");
    expect(findViewHost(tree, [w], "note")).toBeNull();
  });

  it("findTabInTree / findTabInDetached 命中", () => {
    const tree = makeArea(["canvas"]);
    const tab = collectTabs(tree)[0]!;
    expect(findTabInTree(tree, tab.id)?.tab.view).toBe("canvas");
    expect(findTabInTree(tree, "nope")).toBeNull();
    const w: DetachedWindow = {
      id: "w1",
      tabs: [createTab("table")],
      activeTabId: null,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
    expect(findTabInDetached([w], w.tabs[0]!.id)?.window.id).toBe("w1");
    expect(findTabInDetached([w], "nope")).toBeNull();
  });
});

describe("旧 schema 迁移", () => {
  it("view 字段面积 → 单标签面积（id 保留，标签激活）", () => {
    const legacy: LayoutNode = { kind: "area", id: "area-1", view: "canvas" } as never;
    const migrated = migrateLegacyTree(legacy);
    expect(migrated.kind).toBe("area");
    const area = migrated as ReturnType<typeof createArea>;
    expect(area.id).toBe("area-1");
    expect(area.tabs).toHaveLength(1);
    expect(area.tabs[0]!.view).toBe("canvas");
    expect(area.tabs[0]!.locked).toBe(false);
    expect(area.activeTabId).toBe(area.tabs[0]!.id);
  });

  it("view = empty 面积 → 空面积", () => {
    const legacy: LayoutNode = { kind: "area", id: "area-1", view: "empty" } as never;
    const migrated = migrateLegacyTree(legacy);
    expect(migrated.kind).toBe("area");
    const area = migrated as ReturnType<typeof createArea>;
    expect(area.tabs).toEqual([]);
    expect(area.activeTabId).toBeNull();
  });

  it("递归迁移 split 树（子面积逐个转标签组，split 结构保留）", () => {
    const legacy: LayoutNode = {
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { kind: "area", id: "a1", view: "files" },
        { kind: "area", id: "a2", view: "canvas" },
      ],
    } as never;
    const migrated = migrateLegacyTree(legacy);
    const areas = collectAreas(migrated);
    expect(areas.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(collectViewsInTree(migrated)).toEqual(["files", "canvas"]);
  });

  it("已迁移的新形状原样返回", () => {
    const tree = makeArea(["canvas"]);
    expect(migrateLegacyTree(tree)).toBe(tree);
  });
});

describe("布局复制 id 重生成", () => {
  it("regenerateIds 全部节点与标签换新 id，activeTabId 重映射，结构不变", () => {
    const tree = makeArea(["canvas", "note"]);
    const originalIds = {
      area: collectAreas(tree)[0]!.id,
      tabs: collectTabs(tree).map((t) => t.id),
    };
    const copy = regenerateIds(tree);
    const copyArea = collectAreas(copy)[0]!;
    expect(copyArea.id).not.toBe(originalIds.area);
    expect(copyArea.tabs.map((t) => t.id)).not.toEqual(originalIds.tabs);
    expect(copyArea.tabs.map((t) => t.view)).toEqual(["canvas", "note"]);
    expect(copyArea.activeTabId).toBe(copyArea.tabs[0]!.id);
  });
});
