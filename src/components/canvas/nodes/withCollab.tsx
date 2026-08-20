/**
 * 画布节点协作装饰 HOC：包一层 React Flow 节点组件，叠加协作视觉层——
 * - 远端选中高亮：用户色描边（多用户同心叠加，inset 递增，视觉与表格单元格高亮一致）
 * - 远端生成中：节点右上角用户色脉冲点（AI 流式进行中）
 *
 * 非侵入：不修改基础节点组件内部，overlay 用 absolute inset-0 pointer-events-none。
 * 协作状态经 useNodeCollab 订阅 store 实时更新（不受 memo 阻止——store 订阅强制重渲染）。
 */
import { memo, type ComponentType } from "react";
import { useNodeCollab } from "@/hooks/useNodeCollab";

export function withCollab<P extends { id?: string }>(
  Wrapped: ComponentType<P>,
): ComponentType<P> {
  return memo(function CollabNodeWrapper(props: P) {
    const nodeId = props.id ?? "";
    const { selectingPeers, streamingPeers } = useNodeCollab(nodeId);
    const streamingPeer = streamingPeers[0];
    return (
      <div className="relative w-full h-full">
        <Wrapped {...props} />
        {selectingPeers.map((p, i) => (
          <div
            key={p.peerId}
            className="absolute rounded pointer-events-none"
            style={{
              inset: i * 3,
              border: `2px solid ${p.color}`,
            }}
          />
        ))}
        {streamingPeer && (
          <div
            className="absolute top-1 right-1 w-2 h-2 rounded-full pointer-events-none animate-pulse"
            style={{ background: streamingPeer.color }}
            title={`${streamingPeer.nickname} 正在生成`}
          />
        )}
      </div>
    );
  });
}
