/**
 * 画布布局工具。
 *
 * findFreeSpot：给定基准位置与节点估算尺寸，在已有节点中找一个不重叠的位置。
 * 策略——先试基准点；命中则向下堆叠（同列）；同列堆满则向右换列再向下。
 * 用于媒体/文本节点创建（影子节点、固定到画布、历史提取），避免落在已有节点上重叠。
 */
interface SpotNode {
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
}

export function findFreeSpot(
  nodes: SpotNode[],
  base: { x: number; y: number },
  size: { w: number; h: number },
  gap = 24
): { x: number; y: number } {
  // 已有节点的矩形（取用户 resize 尺寸，回退测量值，再回退经验默认）
  const rects = nodes.map((n) => ({
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? 260,
    h: n.height ?? n.measured?.height ?? 180,
  }));
  const intersects = (x: number, y: number) =>
    rects.some(
      (r) => !(x + size.w <= r.x || x >= r.x + r.w || y + size.h <= r.y || y >= r.y + r.h)
    );

  // 1. 基准点
  if (!intersects(base.x, base.y)) return { x: base.x, y: base.y };

  const stepX = size.w + gap;
  const stepY = size.h + gap;
  const rowsPerCol = 40;
  const maxCols = 6;

  // 2. 同列向下堆叠
  for (let row = 1; row <= rowsPerCol; row++) {
    const y = base.y + row * stepY;
    if (!intersects(base.x, y)) return { x: base.x, y };
  }
  // 3. 换列后向下
  for (let col = 1; col <= maxCols; col++) {
    const x = base.x + col * stepX;
    for (let row = 0; row <= rowsPerCol; row++) {
      const y = base.y + row * stepY;
      if (!intersects(x, y)) return { x, y };
    }
  }
  // 4. 兜底：基准点（极端密集画布）
  return { x: base.x, y: base.y };
}

/** 节点矩形（中心计算用，坐标 + 尺寸）。 */
export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 边锚点自适应：按两节点中心相对方位选择连接边对。
 * |dx|>|dy| 水平主导 → 源用左/右边、目标用对侧；否则垂直主导 → 源用顶/底边、目标用对侧。
 * 返回的 handle id 与 `ConnectionFrame` 的四边 handle 命名对齐（`{Side}-source|target`，Side 小写，Position 枚举值）。
 */
export function pickEdgeHandles(
  source: NodeRect,
  target: NodeRect
): { sourceHandle: string; targetHandle: string } {
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "right-source", targetHandle: "left-target" }
      : { sourceHandle: "left-source", targetHandle: "right-target" };
  }
  return dy >= 0
    ? { sourceHandle: "bottom-source", targetHandle: "top-target" }
    : { sourceHandle: "top-source", targetHandle: "bottom-target" };
}
