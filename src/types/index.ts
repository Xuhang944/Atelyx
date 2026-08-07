export type {
  NodeKind,
  ConversationData,
  TextData,
  MediaData,
  SearchResultItem,
  SearchResultData,
  CanvasNodeData,
  CanvasNode,
  CanvasEdge,
  LinkMode,
} from "./node";

export type { Role, Attachment, PendingAttachment, MessageRef, Message } from "./message";

export {
  EDITOR_CHATS_SCHEMA,
  EDITOR_CHATS_SCHEMA_V1,
  CHAT_HISTORY_DIR,
  CHAT_MESSAGE_EXT,
  type EditorChatRole,
  type EditorChatMessage,
  type EditorChatMessageRef,
  type EditorChatIndexEntry,
  type EditorChatSession,
  type EditorChatModelOverride,
  type EditorChatsFile,
  type EditorChatsFileOnDisk,
} from "./chat";

export type {
  ProviderConfig,
  ProviderModel,
  AiConfig,
  GlobalProvider,
  ChatTargetResult,
} from "./provider";

export {
  type CanvasViewport,
  type CanvasFile,
  type CanvasFileNode,
  type ConversationFileData,
  type TextFileData,
  type MediaFileData,
  type GroupFileData,
  type LinkFileData,
  type CanvasFileEdge,
  type CanvasFileRow,
  type CanvasCreateResult,
  type FileTreeNode,
  type FileExplorerSortKey,
  type DirNames,
  type GlobalSearchConfig,
  type SearchProvider,
  type ThemeMode,
  type VaultConfig,
  type VaultInfo,
  type RecentVault,
  type GlobalConfig,
  type WhiteboardFile,
  type WhiteboardNode,
  type WhiteboardEdge,
} from "./canvas";

export { UI_STATE_SCHEMA, type DeviceUiState, type LastActiveWindow, type VaultUiState } from "./uiState";

export type { VaultFileChange } from "./watcher";
