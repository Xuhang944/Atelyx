/**
 * AI 对话面板视图面板。
 * 当前打开笔记不经本视图传递：发送时由 chatPanelStore 以尾部上下文块随请求注入（见 runExchange）。
 */
import { AiChatPanel } from "@/components/canvas/panels/AiChatPanel";
import { useAppStore } from "@/stores/appStore";

export function AiChatView() {
  const openNote = useAppStore((s) => s.openNote);

  return <AiChatPanel onOpenNote={openNote} />;
}
