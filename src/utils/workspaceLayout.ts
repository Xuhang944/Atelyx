/**
 * 工作区布局树操作纯函数（不可变更新）。
 *
 * 语义：
 * - 分割：优先同级插入（父 split 方向匹配时，新空面积插到该面积前/后，满足左中右多面板）；
 *   否则嵌套回退（面积 → Split[面积, 新空面积]）
 * - 关闭：从父 split 移除该面积；children 剩 1 个时父塌缩（唯一子节点顶替其位置），根面积不可关闭
 * - 标签：面积持标签组（tabs + 激活标签），空面积（tabs 空）留在树中，可添加视图或删除
 * - 撕裂：标签从树面积移除（面积留空）→ 挂到应用级 `DetachedWindow`；拖回 = 反向
 * - 视图切换：标签激活即切换（视图与布局解耦，见 `types/workspaceLayout.ts`）
 *
 * 面积/标签 id 由调用方生成（crypto.randomUUID），本文件只更新结构。
 */
import type {
  AreaNode,
  DetachedWindow,
  LayoutNode,
  SplitDirection,
  SplitNode,
  TabItem,
  ViewKind,
} from "@/types";

/** 收集树中全部面积节点（深度优先，顺序稳定）。 */
export function collectAreas(tree: LayoutNode): AreaNode[] {
  if (tree.kind === "area") return [tree];
  return tree.children.flatMap(collectAreas);
}

/** 按 id 查找面积节点（无则 null）。 */
export function findArea(tree: LayoutNode, areaId: string): AreaNode | null {
  return collectAreas(tree).find((a) => a.id === areaId) ?? null;
}

/** 收集树中全部标签（深度优先，顺序稳定）。 */
export function collectTabs(tree: LayoutNode): TabItem[] {
  return collectAreas(tree).flatMap((a) => a.tabs);
}

/** 收集树中全部非空视图（不含重复——标签组内同视图不重复，跨面积也全局唯一）。 */
export function collectViewsInTree(tree: LayoutNode): ViewKind[] {
  return collectTabs(tree).map((t) => t.view);
}

/** 在树中按标签 id 查找（返回所在面积 + 标签；无则 null）。 */
export function findTabInTree(
  tree: LayoutNode,
  tabId: string,
): { area: AreaNode; tab: TabItem } | null {
  for (const area of collectAreas(tree)) {
    const tab = area.tabs.find((t) => t.id === tabId);
    if (tab) return { area, tab };
  }
  return null;
}

/** 在撕裂窗口中按标签 id 查找（返回所在窗口 + 标签；无则 null）。 */
export function findTabInDetached(
  detachedWindows: DetachedWindow[],
  tabId: string,
): { window: DetachedWindow; tab: TabItem } | null {
  for (const win of detachedWindows) {
    const tab = win.tabs.find((t) => t.id === tabId);
    if (tab) return { window: win, tab };
  }
  return null;
}

/** 树 + 撕裂窗口合计的全部非空视图（「已占用视图」判定依据，全局唯一约束）。 */
export function collectAllViews(tree: LayoutNode, detachedWindows: DetachedWindow[]): ViewKind[] {
  return [
    ...collectViewsInTree(tree),
    ...detachedWindows.flatMap((w) => w.tabs.map((t) => t.view)),
  ];
}

/** 视图当前所在宿主："main" = 主窗口面积树，string = 撕裂窗口 id，null = 未渲染。 */
export function findViewHost(
  tree: LayoutNode,
  detachedWindows: DetachedWindow[],
  view: ViewKind,
): "main" | string | null {
  if (collectViewsInTree(tree).includes(view)) return "main";
  for (const w of detachedWindows) {
    if (w.tabs.some((t) => t.view === view)) return w.id;
  }
  return null;
}

/** 面积的激活标签（tabs 空返回 null）。 */
export function activeTabOf(area: AreaNode): TabItem | null {
  return area.tabs.find((t) => t.id === area.activeTabId) ?? area.tabs[0] ?? null;
}

/** 面积的激活视图（空面积返回 null）。 */
export function activeViewOf(area: AreaNode): ViewKind | null {
  return activeTabOf(area)?.view ?? null;
}

/** 查找面积节点的父 split 与下标（无父（根面积）返回 null；分割/关闭用）。 */
export function parentSplitOf(
  tree: LayoutNode,
  areaId: string,
): { split: SplitNode; index: number } | null {
  if (tree.kind === "area") return null;
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (child.kind === "area") {
      if (child.id === areaId) return { split: tree, index: i };
    } else {
      const hit = parentSplitOf(child, areaId);
      if (hit) return hit;
    }
  }
  return null;
}

/** 在面积中插入标签（默认尾部）并激活；面积 id 不存在时原树不变。 */
export function addTabToArea(
  tree: LayoutNode,
  areaId: string,
  tab: TabItem,
  index?: number,
): LayoutNode {
  return mapArea(tree, areaId, (area) => {
    const i = index ?? area.tabs.length;
    const tabs = [...area.tabs];
    tabs.splice(Math.min(i, tabs.length), 0, tab);
    return { ...area, tabs, activeTabId: tab.id };
  });
}

/**
 * 从面积移除标签（面积保留在树中）。被移除的是激活标签时激活邻居
 * （右邻优先，VS Code 语义：Math.min(原下标, 新长度-1)）；移除后空 → 空面积。
 */
export function removeTabFromArea(tree: LayoutNode, areaId: string, tabId: string): LayoutNode {
  return mapArea(tree, areaId, (area) => {
    const i = area.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return area;
    const tabs = area.tabs.filter((t) => t.id !== tabId);
    let activeTabId = area.activeTabId;
    if (activeTabId === tabId) {
      if (tabs.length === 0) activeTabId = null;
      else activeTabId = (tabs[Math.min(i, tabs.length - 1)] ?? tabs[0]).id;
    }
    return { ...area, tabs, activeTabId };
  });
}

/** 激活面积中的标签（不存在/面积不存在时原树不变）。 */
export function setActiveTab(tree: LayoutNode, areaId: string, tabId: string): LayoutNode {
  return mapArea(tree, areaId, (area) =>
    area.tabs.some((t) => t.id === tabId) ? { ...area, activeTabId: tabId } : area,
  );
}

/** 锁定/解锁面积中的标签。 */
export function setTabLocked(
  tree: LayoutNode,
  areaId: string,
  tabId: string,
  locked: boolean,
): LayoutNode {
  return mapArea(tree, areaId, (area) => ({
    ...area,
    tabs: area.tabs.map((t) => (t.id === tabId ? { ...t, locked } : t)),
  }));
}

/** 面积标签组内排序（把 tabId 移到 toIndex，前移后移均按移除后下标处理）。 */
export function moveTabWithinArea(
  tree: LayoutNode,
  areaId: string,
  tabId: string,
  toIndex: number,
): LayoutNode {
  return mapArea(tree, areaId, (area) => {
    const from = area.tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return area;
    const tabs = [...area.tabs];
    const [moved] = tabs.splice(from, 1);
    if (!moved) return area;
    const target = from < toIndex ? toIndex - 1 : toIndex;
    tabs.splice(Math.max(0, Math.min(target, tabs.length)), 0, moved);
    return { ...area, tabs };
  });
}

/**
 * 分割面积：插入新空面积承载新面板。
 * - 父 split 存在且方向匹配 → **同级插入**（新空面积插到该面积前/后，多叉左中右）
 * - 否则 → **嵌套回退**（该面积替换为 Split[该面积, 新空面积]，方向按参数）
 * 返回新树与新面积 id。
 */
export function splitArea(
  tree: LayoutNode,
  areaId: string,
  direction: SplitDirection,
  position: "before" | "after" = "after",
): { tree: LayoutNode; newAreaId: string } {
  const newArea: AreaNode = { kind: "area", id: crypto.randomUUID(), tabs: [], activeTabId: null };
  const parent = parentSplitOf(tree, areaId);
  if (parent && parent.split.direction === direction) {
    return { tree: insertSibling(tree, parent.split.id, parent.index, newArea, position), newAreaId: newArea.id };
  }
  return { tree: wrapArea(tree, areaId, direction, newArea, position), newAreaId: newArea.id };
}

/** 同级插入：把新面积插到父 split children 的 index 相邻位，尺寸从该面积均分一半。 */
function insertSibling(
  tree: LayoutNode,
  splitId: string,
  index: number,
  newArea: AreaNode,
  position: "before" | "after",
): LayoutNode {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") return node;
    if (node.id !== splitId) return { ...node, children: node.children.map(apply) };
    const insertAt = position === "before" ? index : index + 1;
    const half = (node.sizes[index] ?? 100) / 2;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(insertAt, 0, newArea);
    sizes.splice(insertAt, 0, half);
    // 原面积减半（before 插入后原面积在 insertAt+1；after 在原 index）
    sizes[position === "before" ? index + 1 : index] = half;
    return { ...node, children, sizes };
  };
  return apply(tree);
}

/** 嵌套回退：把面积替换为 Split[该面积, 新空面积]（direction，新面积按 position 放前/后）。 */
function wrapArea(
  tree: LayoutNode,
  areaId: string,
  direction: SplitDirection,
  newArea: AreaNode,
  position: "before" | "after",
): LayoutNode {
  const wrap = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") {
      if (node.id !== areaId) return node;
      return {
        kind: "split",
        id: crypto.randomUUID(),
        direction,
        children: position === "before" ? [newArea, node] : [node, newArea],
        sizes: [50, 50],
      };
    }
    return { ...node, children: node.children.map(wrap) };
  };
  return wrap(tree);
}

/**
 * 关闭面积 = 从父 split 移除（children 剩 1 个时父塌缩、唯一子节点顶替其位置；
 * 剩余尺寸归一化到 100）。根即该面积（最后一个面积）时返回 null（不可关闭）。
 */
export function closeArea(tree: LayoutNode, areaId: string): LayoutNode | null {
  const removeFromSplit = (node: LayoutNode): { node: LayoutNode | null; removed: boolean } => {
    if (node.kind === "area") {
      if (node.id === areaId) return { node: null, removed: true };
      return { node, removed: false };
    }
    let removed = false;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < node.children.length; i++) {
      const r = removeFromSplit(node.children[i]);
      if (r.removed) {
        removed = true;
        continue;
      }
      if (r.node) {
        children.push(r.node);
        sizes.push(node.sizes[i] ?? 0);
      }
    }
    if (!removed) return { node, removed: false };
    if (children.length === 1) return { node: children[0], removed: true };
    if (children.length === 0) return { node: null, removed: true };
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return {
      node: { ...node, children, sizes: sizes.map((s) => (s / total) * 100) },
      removed: true,
    };
  };
  const r = removeFromSplit(tree);
  return r.removed ? r.node : tree;
}

/** 回写 Split 子树尺寸比例（仅目标 Split 更新 sizes，其余节点保留引用不变——resize 拖拽时叶子引用稳定）。 */
export function setLayoutSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  const applySizes = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") return node;
    const children = node.children.map(applySizes);
    return node.id === splitId ? { ...node, sizes } : { ...node, children };
  };
  return applySizes(tree);
}

/** 撕裂：从面积移除标签（面积留空），返回 { 新树, 被移除的标签 }；无则 null。 */
export function tearOffFromArea(
  tree: LayoutNode,
  areaId: string,
  tabId: string,
): { tree: LayoutNode; tab: TabItem } | null {
  const hit = findTabInTree(tree, tabId);
  if (!hit || hit.area.id !== areaId) return null;
  return { tree: removeTabFromArea(tree, areaId, tabId), tab: hit.tab };
}

/** 把标签停靠进面积（来自撕裂窗口拖回或窗口内移动；默认尾部并激活）。 */
export function dockTabIntoArea(
  tree: LayoutNode,
  areaId: string,
  tab: TabItem,
  index?: number,
): LayoutNode {
  return addTabToArea(tree, areaId, tab, index);
}

/** 在撕裂窗口中插入标签（默认尾部）并激活。 */
export function detachedAddTab(
  detachedWindows: DetachedWindow[],
  windowId: string,
  tab: TabItem,
  index?: number,
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) => {
    const i = index ?? win.tabs.length;
    const tabs = [...win.tabs];
    tabs.splice(Math.min(i, tabs.length), 0, tab);
    return { ...win, tabs, activeTabId: tab.id };
  });
}

/** 从撕裂窗口移除标签（窗口保留，即使被拖空——由调用方决定是否关闭窗口）。 */
export function detachedRemoveTab(
  detachedWindows: DetachedWindow[],
  windowId: string,
  tabId: string,
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) => {
    const i = win.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return win;
    const tabs = win.tabs.filter((t) => t.id !== tabId);
    let activeTabId = win.activeTabId;
    if (activeTabId === tabId) {
      if (tabs.length === 0) activeTabId = null;
      else activeTabId = (tabs[Math.min(i, tabs.length - 1)] ?? tabs[0]).id;
    }
    return { ...win, tabs, activeTabId };
  });
}

/** 激活撕裂窗口中的标签。 */
export function detachedSetActive(
  detachedWindows: DetachedWindow[],
  windowId: string,
  tabId: string,
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) =>
    win.tabs.some((t) => t.id === tabId) ? { ...win, activeTabId: tabId } : win,
  );
}

/** 锁定/解锁撕裂窗口中的标签。 */
export function detachedSetLocked(
  detachedWindows: DetachedWindow[],
  windowId: string,
  tabId: string,
  locked: boolean,
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) => ({
    ...win,
    tabs: win.tabs.map((t) => (t.id === tabId ? { ...t, locked } : t)),
  }));
}

/** 撕裂窗口标签组内排序。 */
export function detachedMoveTab(
  detachedWindows: DetachedWindow[],
  windowId: string,
  tabId: string,
  toIndex: number,
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) => {
    const from = win.tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return win;
    const tabs = [...win.tabs];
    const [moved] = tabs.splice(from, 1);
    if (!moved) return win;
    const target = from < toIndex ? toIndex - 1 : toIndex;
    tabs.splice(Math.max(0, Math.min(target, tabs.length)), 0, moved);
    return { ...win, tabs };
  });
}

/** 更新撕裂窗口位置尺寸。 */
export function detachedSetBounds(
  detachedWindows: DetachedWindow[],
  windowId: string,
  bounds: { x: number; y: number; width: number; height: number },
): DetachedWindow[] {
  return mapDetached(detachedWindows, windowId, (win) => ({ ...win, bounds }));
}

/** 复制布局树时全部节点与标签重新生成 id（布局复制 = 独立副本，id 全局唯一约定，防跨布局按 id 关联状态碰撞）。 */
export function regenerateIds(node: LayoutNode): LayoutNode {
  if (node.kind === "area") {
    const tabs = node.tabs.map((t) => ({ ...t, id: crypto.randomUUID() }));
    return {
      ...node,
      id: crypto.randomUUID(),
      tabs,
      activeTabId: tabs.find((t) => t.id === node.activeTabId)?.id ?? tabs[0]?.id ?? null,
    };
  }
  return {
    ...node,
    id: crypto.randomUUID(),
    children: node.children.map(regenerateIds),
  };
}

/** 递归更新目标面积（未命中返回原节点，叶子引用稳定）。 */
function mapArea(tree: LayoutNode, areaId: string, fn: (area: AreaNode) => AreaNode): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") return node.id === areaId ? fn(node) : node;
    const children = node.children.map(replace);
    if (children.every((c, i) => c === node.children[i])) return node;
    return { ...node, children };
  };
  return replace(tree);
}

/** 递归更新目标撕裂窗口（未命中返回原数组）。 */
function mapDetached(
  detachedWindows: DetachedWindow[],
  windowId: string,
  fn: (win: DetachedWindow) => DetachedWindow,
): DetachedWindow[] {
  let changed = false;
  const next = detachedWindows.map((w) => {
    if (w.id !== windowId) return w;
    const mapped = fn(w);
    if (mapped !== w) changed = true;
    return mapped;
  });
  return changed ? next : detachedWindows;
}

/** 旧布局树形状（面积含 view 字段，schema v1 前的磁盘数据；split 的 children/sizes 已是数组）。 */
type LegacyAreaNode = { kind: "area"; id: string; view?: ViewKind };
type LegacyLayoutNode = LegacyAreaNode | SplitNode;

/** 旧布局迁移：`view` 字段面积 → 标签组（view "empty" → 空面积；面积 id 保留，防聚焦引用失效）；
 * 已迁移的新形状（无 view 字段）原样返回；split 的 sizes 长度不符时均分补齐（防御损坏数据）。 */
export function migrateLegacyTree(node: LegacyLayoutNode): LayoutNode {
  if (node.kind === "area") {
    if (!("view" in node)) return node as AreaNode;
    const view = node.view ?? "empty";
    if (view === "empty") {
      return { kind: "area", id: node.id, tabs: [], activeTabId: null };
    }
    const tab: TabItem = { id: crypto.randomUUID(), view, locked: false };
    return { kind: "area", id: node.id, tabs: [tab], activeTabId: tab.id };
  }
  const children = node.children.map(migrateLegacyTree);
  const sizes =
    Array.isArray(node.sizes) && node.sizes.length === children.length
      ? node.sizes
      : children.map(() => 100 / children.length);
  return { ...node, children, sizes };
}
