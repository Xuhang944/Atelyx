import { Handle, Position } from "@xyflow/react";

/**
 * 节点连接边框（替代 handle 圆点）。
 * 一圈圆角矩形虚线边框把节点围起来（不紧贴，间距 GAP），
 * 四边各重叠两个长条 handle（source + target，上层可交互）——
 * 鼠标可从边框任意位置拉线连接到另一个节点的边框。
 *
 * 层序：topType 指定的类型渲染在上层（点击/释放优先命中）：
 * - 产出方（文本/媒体）：source 在上 → 从边框拉出
 * - 消费方（对话）：target 在上 → 拉线接入边框（也从边框拉出到产出方，方向仍为产出→消费）
 * connectionMode 为 Loose：任意 handle 组合可连接，连线语义由两端节点类型自动分类（isValidConnection 兜底）。
 */

/** 边框与节点的间距（px） */
const GAP = 10;
/** 连接条厚度（px），以节点边缘为中心覆盖边框带 */
const STRIP = 20;

interface Props {
  /** 上层 handle 类型：产出方 source / 消费方 target */
  topType: "source" | "target";
}

const STRIP_STYLE = {
  transform: "none",
  borderRadius: 0,
  border: "none",
  background: "transparent",
} as const;

/** 四边的条状定位（覆盖 React Flow 默认圆点样式，拉伸成整条边） */
function stripStyle(position: Position): React.CSSProperties {
  switch (position) {
    case Position.Top:
      return { ...STRIP_STYLE, top: -GAP, left: 0, width: "100%", height: STRIP };
    case Position.Bottom:
      return { ...STRIP_STYLE, bottom: -GAP, left: 0, width: "100%", height: STRIP };
    case Position.Left:
      return { ...STRIP_STYLE, left: -GAP, top: 0, width: STRIP, height: "100%" };
    case Position.Right:
      return { ...STRIP_STYLE, right: -GAP, top: 0, width: STRIP, height: "100%" };
  }
}

export function ConnectionFrame({ topType }: Props) {
  const bottomType = topType === "source" ? "target" : "source";
  const positions = [Position.Top, Position.Bottom, Position.Left, Position.Right];
  return (
    <>
      {/* 圆角矩形边框：纯视觉提示可拉区域，不拦截事件 */}
      <div
        aria-hidden
        className="pointer-events-none absolute rounded-2xl"
        style={{
          inset: -GAP,
          border: "1.5px dashed rgba(212,175,55,0.4)",
        }}
      />
      {/* 下层 handle（先渲染被上层覆盖；终点命中上层 handle 优先） */}
      {positions.map((p) => (
        <Handle
          key={`${p}-${bottomType}`}
          type={bottomType}
          position={p}
          id={`${p}-${bottomType}`}
          className="conn-strip"
          style={stripStyle(p)}
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
        />
      ))}
    </>
  );
}
