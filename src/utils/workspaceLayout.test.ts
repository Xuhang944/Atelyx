/**
 * 工作区布局树操作契约测试（utils/workspaceLayout）。
 *
 * 覆盖：标签组操作（增删/激活/锁定/排序/切换视图）、分割/关闭、撕裂/停靠、撕裂窗口操作、
 * 全局视图唯一与宿主判定、布局复制 id 重生成。
 */
import { describe, expect, it } from "vitest";
import {
  addTabToPanel,
  closePanel,
  collectAllViews,
  collectPanels,
  collectTabs,
  detachedAddTab,
  detachedMoveTab,
  detachedRemoveTab,
  detachedSetActive,
  detachedSetBounds,
  detachedSetLocked,
  detachedSetTabView,
  findTabInDetached,
  findTabInTree,
  findViewHost,
  moveTabWithinPanel,
  parentSplitOf,
  regenerateIds,
  removeTabFromPanel,
  setActiveTab,
  setTabLocked,
  setTabView,
  splitPanel,
  tearOffFromPanel,
} from "./workspaceLayout";
import {
  createPanel,
  createTab,
  type DetachedWindow,
  type LayoutNode,
  type SplitNode,
} from "@/types/workspaceLayout";

function makePanel(views: string[], active = 0): LayoutNode {
  const panel = createPanel(views[0] as never);
  for (let i = 1; i < views.length; i++) {
    // 直接构造多标签面板（避免依赖被测试函数本身）
    panel.tabs.push(createTab(views[i] as never));
  }
  panel.activeTabId = panel.tabs[active]?.id ?? panel.tabs[0]?.id ?? null;
  return panel;
}

describe("标签组基础操作", () => {
  it("addTabToPanel 插入尾部并激活", () => {
    const tree = makePanel(["canvas", "note"]);
    const panel = collectPanels(tree)[0];
    const tab = createTab("table");
    const next = addTabToPanel(tree, panel!.id, tab);
    const nextPanel = collectPanels(next)[0];
    expect(nextPanel!.tabs.map((t) => t.view)).toEqual(["canvas", "note", "table"]);
    expect(nextPanel!.activeTabId).toBe(tab.id);
  });

  it("addTabToPanel 支持指定插入位置", () => {
    const tree = makePanel(["canvas", "table"]);
    const panel = collectPanels(tree)[0];
    const tab = createTab("note");
    const next = addTabToPanel(tree, panel!.id, tab, 1);
    expect(collectPanels(next)[0]!.tabs.map((t) => t.view)).toEqual(["canvas", "note", "table"]);
  });

  it("removeTabFromPanel 移除非激活标签不动激活位", () => {
    const tree = makePanel(["canvas", "note", "table"], 1);
    const panel = collectPanels(tree)[0];
    const next = removeTabFromPanel(tree, panel!.id, panel!.tabs[0]!.id);
    const nextPanel = collectPanels(next)[0];
    expect(nextPanel!.tabs.map((t) => t.view)).toEqual(["note", "table"]);
    expect(nextPanel!.activeTabId).toBe(panel!.tabs[1]!.id);
  });

  it("removeTabFromPanel 移除激活标签时激活右邻（VS Code 语义）", () => {
    const tree = makePanel(["canvas", "note", "table"], 0);
    const panel = collectPanels(tree)[0];
    const next = removeTabFromPanel(tree, panel!.id, panel!.tabs[0]!.id);
    const nextPanel = collectPanels(next)[0];
    expect(nextPanel!.activeTabId).toBe(panel!.tabs[1]!.id);
  });

  it("removeTabFromPanel 移除最后一个标签 → 空面板（保留在树中）", () => {
    const tree = makePanel(["canvas"]);
    const panel = collectPanels(tree)[0];
    const next = removeTabFromPanel(tree, panel!.id, panel!.tabs[0]!.id);
    const nextPanel = collectPanels(next)[0];
    expect(nextPanel!.tabs).toEqual([]);
    expect(nextPanel!.activeTabId).toBeNull();
    expect(collectPanels(next)).toHaveLength(1);
  });

  it("setActiveTab / setTabLocked / setTabView", () => {
    const tree = makePanel(["canvas", "note"]);
    const panel = collectPanels(tree)[0];
    const locked = setTabLocked(tree, panel!.id, panel!.tabs[1]!.id, true);
    expect(collectPanels(locked)[0]!.tabs[1]!.locked).toBe(true);
    const activated = setActiveTab(locked, panel!.id, panel!.tabs[1]!.id);
    expect(collectPanels(activated)[0]!.activeTabId).toBe(panel!.tabs[1]!.id);
    // 切换视图：把 canvas 标签换成 files，其余标签不动
    const switched = setTabView(activated, panel!.id, panel!.tabs[0]!.id, "files");
    const switchedPanel = collectPanels(switched)[0]!;
    expect(switchedPanel.tabs[0]!.view).toBe("files");
    expect(switchedPanel.tabs[1]!.view).toBe("note");
  });

  it("moveTabWithinPanel 组内排序（toIndex = 插入点下标）", () => {
    const tree = makePanel(["a", "b", "c"]);
    const panel = collectPanels(tree)[0];
    // 后移：a 拖到 b、c 之间（插入点 2）→ [b, a, c]
    const moved = moveTabWithinPanel(tree, panel!.id, panel!.tabs[0]!.id, 2);
    expect(collectPanels(moved)[0]!.tabs.map((t) => t.view)).toEqual(["b", "a", "c"]);
    // 拖到末尾（插入点 3）→ [b, c, a]
    const end = moveTabWithinPanel(moved, panel!.id, panel!.tabs[0]!.id, 3);
    expect(collectPanels(end)[0]!.tabs.map((t) => t.view)).toEqual(["b", "c", "a"]);
    // 前移：a 从末尾拖回开头（插入点 0）
    const back = moveTabWithinPanel(end, panel!.id, collectPanels(end)[0]!.tabs[2]!.id, 0);
    expect(collectPanels(back)[0]!.tabs.map((t) => t.view)).toEqual(["a", "b", "c"]);
  });
});

describe("分割 / 关闭", () => {
  it("根面板分割 → 嵌套回退（面板 → Split[原面板, 新空面板]），均分", () => {
    const tree = makePanel(["canvas", "note"]);
    const panel = collectPanels(tree)[0];
    const { tree: next, newPanelId } = splitPanel(tree, panel!.id, "horizontal");
    const panels = collectPanels(next);
    expect(panels).toHaveLength(2);
    expect(panels[0]!.tabs.map((t) => t.view)).toEqual(["canvas", "note"]);
    expect(panels[1]!.tabs).toEqual([]);
    expect(panels[1]!.id).toBe(newPanelId);
  });

  it("closePanel 合并到兄弟（兄弟顶替）；根面板不可关闭", () => {
    const tree = makePanel(["canvas"]);
    expect(closePanel(tree, collectPanels(tree)[0]!.id)).toBeNull();
    const { tree: split } = splitPanel(tree, collectPanels(tree)[0]!.id, "horizontal");
    const panels = collectPanels(split);
    const closed = closePanel(split, panels[1]!.id);
    expect(collectPanels(closed!)).toHaveLength(1);
    expect(collectPanels(closed!)[0]!.tabs.map((t) => t.view)).toEqual(["canvas"]);
  });

  it("closePanel 嵌套：删除内层 split 中的面板只删目标，父塌缩、兄弟保留", () => {
    // Split H [ A | Split V [ B | C ] ]，删 B → Split H [ A | C ]（V 塌缩为 C）
    const tree: LayoutNode = {
      kind: "split",
      id: "outer",
      direction: "horizontal",
      sizes: [40, 60],
      children: [
        createPanel("files"),
        {
          kind: "split",
          id: "inner",
          direction: "vertical",
          sizes: [50, 50],
          children: [createPanel("canvas"), createPanel("note")],
        },
      ],
    };
    const target = collectPanels(tree)[1]!; // canvas（V 内第一个）
    const closed = closePanel(tree, target.id);
    expect(closed!.kind).toBe("split");
    expect(collectPanels(closed!).map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      collectPanels(tree)[2]!.id,
    ]);
    const split = closed as SplitNode;
    expect(split.children.map((c) => c.kind)).toEqual(["panel", "panel"]);
    expect(split.sizes).toEqual([40, 60]);
  });

  it("closePanel 深层嵌套：只删目标，整条祖先链塌缩后其余面板保留", () => {
    // Split H [ files | Split H [ Split V[canvas | new] | inspector ] ]，删 new →
    // Split H [ files | Split H [ canvas | inspector ] ]（canvas 顶替 V 槽位）
    const tree: LayoutNode = {
      kind: "split",
      id: "root",
      direction: "horizontal",
      sizes: [17, 83],
      children: [
        createPanel("files"),
        {
          kind: "split",
          id: "inner",
          direction: "horizontal",
          sizes: [74, 26],
          children: [
            {
              kind: "split",
              id: "v",
              direction: "vertical",
              sizes: [50, 50],
              children: [createPanel("canvas"), createPanel("search")],
            },
            createPanel("inspector"),
          ],
        },
      ],
    };
    const target = collectPanels(tree)[2]!; // search（V 内第二个）
    const closed = closePanel(tree, target.id);
    expect(collectPanels(closed!).map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      collectPanels(tree)[1]!.id,
      collectPanels(tree)[3]!.id,
    ]);
    expect(collectPanels(closed!).map((p) => p.tabs[0]!.view)).toEqual(["files", "canvas", "inspector"]);
    const root = closed as SplitNode;
    const inner = root.children[1] as SplitNode;
    expect(root.children).toHaveLength(2);
    expect(inner.children.map((c) => c.kind)).toEqual(["panel", "panel"]);
    expect(inner.sizes).toEqual([74, 26]);
  });
});

describe("多叉同级分割（左中右）", () => {
  const trio = (): LayoutNode => ({
    kind: "split",
    id: "s1",
    direction: "horizontal",
    children: [createPanel("files"), createPanel("canvas"), createPanel("inspector")],
    sizes: [30, 40, 30],
  });

  it("父方向匹配 → 同级插入到目标面板后，尺寸从相邻面板均分", () => {
    const tree = trio();
    const target = collectPanels(tree)[1]!; // canvas
    const { tree: next, newPanelId } = splitPanel(tree, target.id, "horizontal", "after");
    const panels = collectPanels(next);
    expect(panels.map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      target.id,
      newPanelId,
      collectPanels(tree)[2]!.id,
    ]);
    const split = next as SplitNode;
    expect(split.sizes).toEqual([30, 20, 20, 30]);
  });

  it("before 插入到目标面板前", () => {
    const tree = trio();
    const target = collectPanels(tree)[1]!;
    const { tree: next, newPanelId } = splitPanel(tree, target.id, "horizontal", "before");
    const panels = collectPanels(next);
    expect(panels.map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      newPanelId,
      target.id,
      collectPanels(tree)[2]!.id,
    ]);
    expect((next as SplitNode).sizes).toEqual([30, 20, 20, 30]);
  });

  it("父方向不匹配 → 嵌套回退（面板 → 垂直 Split[原面板, 新面板]）", () => {
    const tree = trio();
    const target = collectPanels(tree)[1]!;
    const { tree: next, newPanelId } = splitPanel(tree, target.id, "vertical", "after");
    // 树变 [files, [canvas | new], inspector]：外层 3 面板变 2 子树（canvas 被包裹）
    const panels = collectPanels(next);
    expect(panels.map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      target.id,
      newPanelId,
      collectPanels(tree)[2]!.id,
    ]);
    expect(panels).toHaveLength(4);
  });

  it("closePanel 多叉移除中间面板：剩 2 个时尺寸归一化到 100", () => {
    const tree = trio();
    const target = collectPanels(tree)[1]!;
    const closed = closePanel(tree, target.id);
    expect(closed!.kind).toBe("split");
    const split = closed as SplitNode;
    expect(collectPanels(split).map((p) => p.id)).toEqual([
      collectPanels(tree)[0]!.id,
      collectPanels(tree)[2]!.id,
    ]);
    expect(split.sizes).toEqual([50, 50]);
  });

  it("closePanel 移除后剩 1 个 → 父塌缩（唯一子节点顶替）", () => {
    const tree: LayoutNode = {
      kind: "split",
      id: "s1",
      direction: "horizontal",
      children: [createPanel("files"), createPanel("canvas")],
      sizes: [40, 60],
    };
    const target = collectPanels(tree)[1]!;
    const closed = closePanel(tree, target.id);
    expect(closed!.kind).toBe("panel");
    expect((closed as ReturnType<typeof createPanel>).tabs.map((t) => t.view)).toEqual(["files"]);
  });

  it("parentSplitOf 定位父 split 与下标", () => {
    const tree = trio();
    const target = collectPanels(tree)[2]!;
    const hit = parentSplitOf(tree, target.id);
    expect(hit?.split.id).toBe("s1");
    expect(hit?.index).toBe(2);
    expect(parentSplitOf(tree, "missing")).toBeNull();
    // 根面板无父
    expect(parentSplitOf(createPanel("files"), createPanel("files").id)).toBeNull();
  });
});

describe("撕裂 / 停靠", () => {
  it("tearOffFromPanel 移除标签（面板留空）并返回标签", () => {
    const tree = makePanel(["canvas", "note"]);
    const panel = collectPanels(tree)[0];
    const hit = tearOffFromPanel(tree, panel!.id, panel!.tabs[0]!.id);
    expect(hit).not.toBeNull();
    expect(hit!.tab.view).toBe("canvas");
    expect(collectPanels(hit!.tree)[0]!.tabs.map((t) => t.view)).toEqual(["note"]);
  });

  it("tearOffFromPanel 最后一个标签撕裂后面板留空", () => {
    const tree = makePanel(["canvas"]);
    const panel = collectPanels(tree)[0];
    const hit = tearOffFromPanel(tree, panel!.id, panel!.tabs[0]!.id);
    expect(hit).not.toBeNull();
    expect(collectPanels(hit!.tree)[0]!.tabs).toEqual([]);
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

  it("detachedMoveTab / detachedSetLocked / detachedSetActive / detachedSetBounds / detachedSetTabView", () => {
    const w = win(["a", "b", "c"]);
    const moved = detachedMoveTab([w], "w1", w.tabs[2]!.id, 0);
    expect(moved[0]!.tabs.map((t) => t.view)).toEqual(["c", "a", "b"]);
    const locked = detachedSetLocked(moved, "w1", moved[0]!.tabs[0]!.id, true);
    expect(locked[0]!.tabs[0]!.locked).toBe(true);
    const active = detachedSetActive(locked, "w1", moved[0]!.tabs[1]!.id);
    expect(active[0]!.activeTabId).toBe(moved[0]!.tabs[1]!.id);
    const bounds = detachedSetBounds(active, "w1", { x: 10, y: 20, width: 500, height: 600 });
    expect(bounds[0]!.bounds).toEqual({ x: 10, y: 20, width: 500, height: 600 });
    // 切换撕裂窗口标签视图：c 标签 → files，其余不动
    const switched = detachedSetTabView(bounds, "w1", bounds[0]!.tabs[0]!.id, "files");
    expect(switched[0]!.tabs[0]!.view).toBe("files");
    expect(switched[0]!.tabs[1]!.view).toBe("a");
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
    const tree = makePanel(["canvas", "note"]);
    const w: DetachedWindow = {
      id: "w1",
      tabs: [createTab("table")],
      activeTabId: null,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
    expect(collectAllViews(tree, [w])).toEqual(["canvas", "note", "table"]);
  });

  it("findViewHost：树内 = main；撕裂窗口 = 窗口 id；未渲染 = null", () => {
    const tree = makePanel(["canvas"]);
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
    const tree = makePanel(["canvas"]);
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

describe("布局复制 id 重生成", () => {
  it("regenerateIds 全部节点与标签换新 id，activeTabId 重映射，结构不变", () => {
    const tree = makePanel(["canvas", "note"]);
    const originalIds = {
      panel: collectPanels(tree)[0]!.id,
      tabs: collectTabs(tree).map((t) => t.id),
    };
    const copy = regenerateIds(tree);
    const copyPanel = collectPanels(copy)[0]!;
    expect(copyPanel.id).not.toBe(originalIds.panel);
    expect(copyPanel.tabs.map((t) => t.id)).not.toEqual(originalIds.tabs);
    expect(copyPanel.tabs.map((t) => t.view)).toEqual(["canvas", "note"]);
    expect(copyPanel.activeTabId).toBe(copyPanel.tabs[0]!.id);
  });
});
