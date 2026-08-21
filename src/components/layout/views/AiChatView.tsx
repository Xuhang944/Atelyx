/**
 * AI 对话面板视图面板。
 * noteFile = 全局当前打开笔记（面板并存下「笔记开着」即注入自动 @，不再要求笔记面板激活）。
 */
import { AiChatPanel } from "@/components/canvas/panels/AiChatPanel";
import { useAppStore } from "@/stores/appStore";

export function AiChatView() {
  const currentNoteFile = useAppStore((s) => s.currentNoteFile);
  const openNote = useAppStore((s) => s.openNote);

  return <AiChatPanel noteFile={currentNoteFile} onOpenNote={openNote} />;
}
