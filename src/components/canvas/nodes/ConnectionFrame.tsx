import { useEffect, useRef, useState } from "react";
import {
  Handle,
  Position,
  useNodeId,
  useReactFlow,
  useStore,
} from "@xyflow/react";

/**
 * 节点连接边框（替代 handle 圆点）。
 * 一圈圆角矩形虚线边框把节点围起来（不紧贴，间距 GAP），
 * 四边各重叠两个长条 handle（source + target，上层可交互）——
 * 鼠标可从边框任意位置拉线连接到另一个节点的边框。
 *
 * 视觉层 = SVG 四边独立 path（直线段 + 圆角圆弧首尾相接成完整圆角矩形），
 * 拉线指示 = 鼠标所在边的虚线向外膨胀（弧峰跟随鼠标实时渲染，见 handleMouseMove 注释）。
 * 尺寸/位置经 useStore 订阅 nodeLookup（measured = 布局像素、positionAbsolute = 世界坐标，
 * React Flow 内置 ResizeObserver 维护，兼容内容撑高的节点），hover 坐标经
 * screenToFlowPosition 换算——两条链路都避开视口 zoom 变换，任何缩放级别下框都精确贴合。
 *
 * 拉线锚点：handle 条带整体外移（中心 = 圆角矩形边框位置）——
 * 拉出的线与接入的线头均以圆角矩形为起点/终点（React Flow 取条带中心为端点）。
 *
 * 层序：topType 指定的类型渲染在上层（点击/释放优先命中）：
 * - 产出方（文本/媒体）：source 在上 → 从边框拉出
 * - 消费方（对话）：target 在上 → 拉线接入边框（也从边框拉出到产出方，方向仍为产出→消费）
 * connectionMode 为 Loose：任意 handle 组合可连接，连线语义由两端节点类型自动分类（isValidConnection 兜底）。
 */

/** 边框与节点的间距（px）：预留呼吸空间，不紧贴节点 */
const GAP = 10;
/** 连接条厚度（px），条带中心 = 圆角矩形边框位置 */
const STRIP = 20;
/** 圆角半径（px），对齐节点 rounded-xl */
const R = 12;
/** 虚线 dash 序列（视觉约同 2px CSS dashed） */
const DASH = "9 6";
/** 膨胀弧控制点外移量（px）：二次贝塞尔峰偏移 = BULGE/2 = 6px（微微鼓起） */
const BULGE = 12;

interface Props {
  /** 上层 handle 类型：产出方 source / 消费方 target */
  topType: "source" | "target";
  /** 节点选中时虚线边框提亮（金色，呼应节点选中态） */
  selected?: boolean;
}

const STRIP_STYLE = {
  transform: "none",
  borderRadius: 0,
  border: "none",
  background: "transparent",
} as const;

/** 四边的条状定位（覆盖 React Flow 默认圆点样式，拉伸成整条边）。
 * 条带整体外移（偏移 GAP + STRIP/2）：中心落在圆角矩形边框（节点外 GAP）位置，
 * 拉线端点 = 条带中心 = 圆角矩形上的点。 */
function stripStyle(position: Position): React.CSSProperties {
  const shift = -(GAP + STRIP / 2);
  switch (position) {
    case Position.Top:
      return {
        ...STRIP_STYLE,
        top: shift,
        left: 0,
        width: "100%",
        height: STRIP,
      };
    case Position.Bottom:
      return {
        ...STRIP_STYLE,
        bottom: shift,
        left: 0,
        width: "100%",
        height: STRIP,
      };
    case Position.Left:
      return {
        ...STRIP_STYLE,
        left: shift,
        top: 0,
        width: STRIP,
        height: "100%",
      };
    case Position.Right:
      return {
        ...STRIP_STYLE,
        right: shift,
        top: 0,
        width: STRIP,
        height: "100%",
      };
  }
}

/** hover 边状态：side = 鼠标所在边，pos = 鼠标沿该边的投影（SVG 局部坐标）。 */
interface HoverState {
  side: Position;
  pos: number;
}

export function ConnectionFrame({ topType, selected }: Props) {
  const bottomType = topType === "source" ? "target" : "source";
  const positions = [
    Position.Top,
    Position.Bottom,
    Position.Left,
    Position.Right,
  ];
  // 订阅当前节点：measured = 布局尺寸（React Flow 内置测量，resize/内容撑高自动更新）；
  // internals.positionAbsolute = 世界坐标（拖动/切画布响应式刷新）。
  // 坐标基准（关键）：SVG 视口 = 节点 + 2×GAP（CSS inset -GAP 撑满，视口原点 = 节点左上 - GAP），
  // 故圆角矩形框直接画在视口边缘 (0,0)-(w+2GAP, h+2GAP)——绝不能再加 GAP 偏移，
  // 否则与 inset 抵消、框永远紧贴节点边缘（GAP 参数失效的根源）
  const nodeId = useNodeId();
  const node = useStore((s) => (nodeId ? s.nodeLookup.get(nodeId) : undefined));
  const w = node?.measured?.width ?? 200;
  const h = node?.measured?.height ?? 120;
  const ox = (node?.internals.positionAbsolute.x ?? 0) - GAP;
  const oy = (node?.internals.positionAbsolute.y ?? 0) - GAP;
  const W = w + 2 * GAP; // 视口尺寸
  const H = h + 2 * GAP;
  const x1 = R; // 直线段起止（视口坐标，圆角让位）
  const x2 = W - R;
  const y1 = R;
  const y2 = H - R;

  const { screenToFlowPosition } = useReactFlow();
  const [hover, setHover] = useState<HoverState | null>(null);
  // rAF 节流：高频 mousemove 只取每帧最后一次坐标（与流式 token 同策略）
  const pendingRef = useRef<HoverState | null>(null);
  const rafRef = useRef(0);
  // 离开延迟复位：同边双 handle 交错 leave/move 时防闪烁（120ms 内刷新则取消）
  const leaveTimerRef = useRef(0);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  const handleMouseMove = (e: React.MouseEvent) => {
    window.clearTimeout(leaveTimerRef.current);
    // 世界坐标 → SVG 局部坐标（减去节点原点）：screenToFlowPosition 已含视口变换，
    // 任意 zoom 下坐标精确，无需手动除缩放
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const x = flow.x - ox;
    const y = flow.y - oy;
    // 最近边判定（鼠标在条带内 = 距视口边缘最近）；投影钳制在直线段范围内（圆角让位）
    const nearest = [
      { side: Position.Top, dist: Math.abs(y - 0) },
      { side: Position.Bottom, dist: Math.abs(y - H) },
      { side: Position.Left, dist: Math.abs(x - 0) },
      { side: Position.Right, dist: Math.abs(x - W) },
    ].sort((a, b) => a.dist - b.dist)[0];
    const pos =
      nearest.side === Position.Top || nearest.side === Position.Bottom
        ? Math.min(Math.max(x, x1), x2)
        : Math.min(Math.max(y, y1), y2);
    pendingRef.current = { side: nearest.side, pos };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p) setHover(p);
    });
  };

  const handleMouseLeave = () => {
    window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => setHover(null), 120);
  };

  // 四边 path：直线段 + 尾端圆角圆弧，首尾相接成完整圆角矩形（视口坐标，框 = 视口边缘）。
  // 膨胀弧 = 直线段换二次贝塞尔（控制点沿法线外移 BULGE → 峰偏移 BULGE/2，顶点跟随鼠标），
  // 两端圆角圆弧保留；非 hover 边保持直线。虚线 dash 随弧线重排，无叠加重影。
  const arcD = (side: Position, pos: number) => {
    switch (side) {
      case Position.Top:
        return `M ${x1},0 Q ${pos},${-BULGE} ${x2},0 A ${R},${R} 0 0 1 ${W},${y1}`;
      case Position.Bottom:
        return `M ${x2},${H} Q ${pos},${H + BULGE} ${x1},${H} A ${R},${R} 0 0 1 0,${y2}`;
      case Position.Left:
        return `M 0,${y2} Q ${-BULGE},${pos} 0,${y1} A ${R},${R} 0 0 1 ${x1},0`;
      case Position.Right:
        return `M ${W},${y1} Q ${W + BULGE},${pos} ${W},${y2} A ${R},${R} 0 0 1 ${x2},${H}`;
    }
  };
  const lineD = (side: Position) => {
    switch (side) {
      case Position.Top:
        return `M ${x1},0 L ${x2},0 A ${R},${R} 0 0 1 ${W},${y1}`;
      case Position.Bottom:
        return `M ${x2},${H} L ${x1},${H} A ${R},${R} 0 0 1 0,${y2}`;
      case Position.Left:
        return `M 0,${y2} L 0,${y1} A ${R},${R} 0 0 1 ${x1},0`;
      case Position.Right:
        return `M ${W},${y1} L ${W},${y2} A ${R},${R} 0 0 1 ${x2},${H}`;
    }
  };
  const edgePath = (side: Position) =>
    hover?.side === side ? arcD(side, hover.pos) : lineD(side);

  return (
    <>
      {/* 视觉层：四边独立 SVG path（虚线 = 常态；选中 = 实线 + 金色发光）。
          pointer-events: none 不拦截事件；膨胀指示由 handle 的 mousemove 驱动 */}
      <svg
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          left: -GAP,
          top: -GAP,
          right: -GAP,
          bottom: -GAP,
          overflow: "visible",
          ...(selected
            ? {
                filter:
                  "drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 55%, transparent))",
              }
            : {}),
        }}
      >
        <g
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={selected ? undefined : DASH}
        >
          {positions.map((p) => (
            <path
              key={p}
              d={edgePath(p)}
              stroke={
                hover?.side === p
                  ? "var(--accent)"
                  : "color-mix(in srgb, var(--accent) 65%, transparent)"
              }
              style={
                hover?.side === p
                  ? {
                      filter:
                        "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 70%, transparent))",
                    }
                  : undefined
              }
            />
          ))}
        </g>
      </svg>
      {/* 下层 handle（先渲染被上层覆盖；终点命中上层 handle 优先） */}
      {positions.map((p) => (
        <Handle
          key={`${p}-${bottomType}`}
          type={bottomType}
          position={p}
          id={`${p}-${bottomType}`}
          className="conn-strip"
          style={stripStyle(p)}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      ))}
      {/* 上层 handle：点击/释放优先命中 */}
      {positions.map((p) => (
        <Handle
          key={`${p}-${topType}`}
          type={topType}
          position={p}
          id={`${p}-${topType}`}
          className="conn-strip"
          style={stripStyle(p)}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      ))}
    </>
  );
}
