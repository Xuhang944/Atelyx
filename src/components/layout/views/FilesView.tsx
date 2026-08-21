/**
 * 文件面板视图面板（薄包装：把文件面板回调直连 appStore 打开动作）。
 */
import { FileExplorerPanel } from "@/components/canvas/panels/FileExplorerPanel";
import { useAppStore } from "@/stores/appStore";

export function FilesView() {
  const openCanvas = useAppStore((s) => s.openCanvas);
  const openNote = useAppStore((s) => s.openNote);
  const openTable = useAppStore((s) => s.openTable);
  const convertWhiteboard = useAppStore((s) => s.convertWhiteboard);
  const currentNoteFile = useAppStore((s) => s.currentNoteFile);
  const currentTableFile = useAppStore((s) => s.currentTableFile);

  return (
    <FileExplorerPanel
      onOpenCanvasFile={openCanvas}
      onOpenNoteForEdit={openNote}
      onOpenTableFile={openTable}
      openedNoteFile={currentNoteFile}
      openedTableFile={currentTableFile}
      onConvertWhiteboard={(file) => void convertWhiteboard(file)}
    />
  );
}
