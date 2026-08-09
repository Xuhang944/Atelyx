/**
 * 工作区布局树操作纯函数（不可变更新）。
 *
 * 语义：
 * - 分割：面积 → Split 节点，原面积保留（children[0]）、新增 empty 面积（children[1]），均分尺寸
 * - 关闭：面积 = 合并到父 Split 的兄弟（父节点塌缩、兄弟顶替），根面积不可关闭
 * - 视图切换：仅替换 Area.view（文件状态与布局解耦，见 `types/workspaceLayout.ts`）
 *
 * 面积 id 由调用方生成（crypto.randomUUID），本文件只更新结构。
 */
import type { AreaNode, LayoutNode, SplitDirection, ViewKind } from "@/types";
/** 收集树中全部面积节点（深度优先，顺序稳定）。 */
export function collectAreas(tree: LayoutNode): AreaNode[] {
  if (tree.kind === "area") return [tree];
  return [...collectAreas(tree.children[0]), ...collectAreas(tree.children[1])];
}

/** 按 id 查找面积节点（无则 null）。 */
export function findArea(tree: LayoutNode, areaId: string): AreaNode | null {
  return collectAreas(tree).find((a) => a.id === areaId) ?? null;
}

/** 分割面积：原地替换为 Split（原面积 + 新 empty 面积），返回新树与新面积 id。 */
export function splitArea(
  tree: LayoutNode,
  areaId: string,
  direction: SplitDirection,
): { tree: LayoutNode; newAreaId: string } {
  const newArea: AreaNode = { kind: "area", id: crypto.randomUUID(), view: "empty" };
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") {
      if (node.id !== areaId) return node;
      return {
        kind: "split",
        id: crypto.randomUUID(),
        direction,
        children: [node, newArea],
        sizes: [50, 50],
      };
    }
    const [a, b] = node.children;
    const aNext = replace(a);
    const bNext = replace(b);
    if (aNext === a && bNext === b) return node;
    return { ...node, children: [aNext, bNext] };
  };
  return { tree: replace(tree), newAreaId: newArea.id };
}

/**
 * 关闭面积 = 合并到父 Split 的兄弟（父塌缩、兄弟顶替其位置）。
 * 根即该面积（最后一个面积）时返回 null（不可关闭）。
 */
export function closeArea(tree: LayoutNode, areaId: string): LayoutNode | null {
  const replace = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "area") return node.id === areaId ? null : node;
    const [a, b] = node.children;
    const aNext = replace(a);
    const bNext = replace(b);
    if (aNext === null) return bNext;
    if (bNext === null) return aNext;
    if (aNext === a && bNext === b) return node;
    return { ...node, children: [aNext, bNext] };
  };
  return replace(tree);
}

/** 切换面积承载的视图类型（面积 id 不存在时原树不变）。 */
export function setAreaView(tree: LayoutNode, areaId: string, view: ViewKind): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") {
      return node.id === areaId ? { ...node, view } : node;
    }
    const [a, b] = node.children;
    const aNext = replace(a);
    const bNext = replace(b);
    if (aNext === a && bNext === b) return node;
    return { ...node, children: [aNext, bNext] };
  };
  return replace(tree);
}

/**
 * 边合并：删除 Split 中 keep 对侧的子子树（整体消失），保留侧顶替其位置。
 * 与 closeArea（关闭单面积）区分：本操作用于边右键「向左/右（上/下）合并」，
 * 被合并的整棵子树（可能含多个面积）直接废弃。
 */
export function mergeSibling(tree: LayoutNode, splitId: string, keep: 0 | 1): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") return node;
    if (node.id === splitId) return node.children[keep];
    const [a, b] = node.children;
    const aNext = replace(a);
    const bNext = replace(b);
    if (aNext === a && bNext === b) return node;
    return { ...node, children: [aNext, bNext] };
  };
  return replace(tree);
}

/** 子树内与 handle 相邻的叶子面积（horizontal split 取 children[i] 最右/最左叶子，vertical 最下/最上叶子）。 */
export function adjacentArea(node: LayoutNode, side: 0 | 1): AreaNode | null {
  if (node.kind === "area") return node;
  const sub = node.children[side];
  const areas = collectAreas(sub);
  if (areas.length === 0) return null;
  // DFS 顺序 = 左→右/上→下；side=1（右/下侧）取最后一个（紧邻 handle），side=0 取第一个
  return side === 1 ? (areas[areas.length - 1] ?? null) : (areas[0] ?? null);
}

/** 回写 Split 子树尺寸比例（仅目标 Split 更新 sizes，其余节点保留引用不变——resize 拖拽时叶子引用稳定）。 */
export function setLayoutSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: [number, number],
): LayoutNode {
  const applySizes = (node: LayoutNode): LayoutNode => {
    if (node.kind === "area") return node;
    const children: [LayoutNode, LayoutNode] = [
      applySizes(node.children[0]),
      applySizes(node.children[1]),
    ];
    return node.id === splitId ? { ...node, sizes } : { ...node, children };
  };
  return applySizes(tree);
}

/** 复制布局树时全部节点重新生成 id（布局复制 = 独立副本，id 全局唯一约定，防跨布局按 id 关联状态碰撞）。 */
export function regenerateIds(node: LayoutNode): LayoutNode {
  if (node.kind === "area") return { ...node, id: crypto.randomUUID() };
  return {
    ...node,
    id: crypto.randomUUID(),
    children: [regenerateIds(node.children[0]), regenerateIds(node.children[1])],
  };
}
