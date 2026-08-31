/**
 * AI 对话面板视图面板（无 props）。
 * 当前打开笔记不经本视图传递：发送时由 chatPanelStore 以尾部上下文块随请求注入（见 runExchange）；
 * @chip 点击按类型打开（openVaultPath，面板内自处理）。
 */
import { AiChatPanel } from "@/components/canvas/panels/AiChatPanel";

export function AiChatView() {
  return <AiChatPanel />;
}
