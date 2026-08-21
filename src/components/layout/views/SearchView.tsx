/**
 * 搜索面板视图面板（薄包装：打开回调直连 appStore）。
 */
import { SearchPanel } from "@/components/canvas/panels/SearchPanel";
import { useAppStore } from "@/stores/appStore";

export function SearchView() {
  const openCanvas = useAppStore((s) => s.openCanvas);
  const openNote = useAppStore((s) => s.openNote);
  const openTable = useAppStore((s) => s.openTable);

  return (
    <SearchPanel
      onOpenCanvasFile={openCanvas}
      onOpenNoteForEdit={openNote}
      onOpenTableFile={openTable}
    />
  );
}
