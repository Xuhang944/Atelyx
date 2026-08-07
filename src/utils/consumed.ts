import type { Message } from "@/types";

/**
 * 该对话消息历史中是否已注入过来自 sourceNodeId 的引用/附件（虚实反推）。
 * refs（文本/搜索）与 attachments.sourceNodeId（媒体）任一命中即视为已消费。
 * 三处消费方共用（DataFlowEdge 虚实反推 / canvasStore.onConnect 再次注入判定 / ConversationNode 取消引用断边）。
 */
export function isAssetConsumed(messages: Message[], sourceNodeId: string): boolean {
  return messages.some(
    (m) =>
      (m.refs ?? []).some((r) => r.nodeId === sourceNodeId) ||
      (m.attachments ?? []).some((a) => a.sourceNodeId === sourceNodeId)
  );
}
