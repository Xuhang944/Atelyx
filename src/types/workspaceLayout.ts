/**
 * 工作区可自定义布局（Blender 式面积网格）。
 *
 * 布局 = 一棵递归二分树：Split 节点表达「分割方向 + 两子树 + 各自占比」，
 * Area 叶子节点表达「一个视图面积」。全局 chrome（标题栏/最左功能栏）不参与面积网格。
 *
 * 约束（产品决策）：
 * - 任一布局内每种视图最多一个面积（文件状态全局唯一，面积只是渲染入口）
 * - 打开文件与布局解耦：布局中没有对应视图面积时文件照常打开，只是无处显示
 *
 * 布局列表 + 激活布局 + 聚焦面积应用级持久化到 `app_data_dir/ui-state.json`
 * （见 `types/uiState.ts` 的 `AppUiState`，Rust 侧 `commands/global.rs` 同步字段）。
 */

/** 视图类型（面积承载的内容）。 */
export type ViewKind =
  | "canvas"
  | "note"
  | "table"
  | "files"
  | "search"
  | "inspector"
  | "aichat"
  | "empty";

/** 分割方向：horizontal = 左右并排，vertical = 上下叠放。 */
export type SplitDirection = "horizontal" | "vertical";

export interface AreaNode {
  kind: "area";
  id: string;
  view: ViewKind;
}

export interface SplitNode {
  kind: "split";
  id: string;
  direction: SplitDirection;
  /** 恰好两棵子树（二分树）。 */
  children: [LayoutNode, LayoutNode];
  /** 两子树的相对尺寸（百分比，和 = 100；相对各自父 Split，随拖拽实时回写）。 */
  sizes: [number, number];
}

export type LayoutNode = AreaNode | SplitNode;

/** 一套命名布局（布局列表的一项）。 */
export interface WorkspaceLayout {
  id: string;
  name: string;
  tree: LayoutNode;
}

/** 视图类型清单（视图选择器选项顺序）。 */
export const VIEW_KINDS: ViewKind[] = [
  "canvas",
  "note",
  "table",
  "files",
  "search",
  "inspector",
  "aichat",
];

/**
 * 默认布局（与旧三栏布局同构）：文件 | 画布 | 属性，比例 22:78，画布/属性 75:25。
 * 首次进入仓库/布局损坏时回退。
 */
export function createDefaultLayout(name = "默认布局"): WorkspaceLayout {
  return {
    id: crypto.randomUUID(),
    name,
    tree: {
      kind: "split",
      id: crypto.randomUUID(),
      direction: "horizontal",
      children: [
        { kind: "area", id: crypto.randomUUID(), view: "files" },
        {
          kind: "split",
          id: crypto.randomUUID(),
          direction: "horizontal",
          children: [
            { kind: "area", id: crypto.randomUUID(), view: "canvas" },
            { kind: "area", id: crypto.randomUUID(), view: "inspector" },
          ],
          sizes: [75, 25],
        },
      ],
      sizes: [22, 78],
    },
  };
}
