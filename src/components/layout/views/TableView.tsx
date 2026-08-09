/**
 * 表格编辑器视图面积（全局当前打开表格；无文件时占位引导）。
 */
import { Table as TableIcon } from "lucide-react";
import { TableEditor } from "@/components/table/TableEditor";
import { AreaPlaceholder } from "@/components/layout/AreaPlaceholder";
import { useAppStore } from "@/stores/appStore";

export function TableView() {
  const currentTableFile = useAppStore((s) => s.currentTableFile);

  if (!currentTableFile) {
    return (
      <AreaPlaceholder
        icon={<TableIcon size={64} strokeWidth={1.5} />}
        title="打开表格"
        description="从左侧文件面板或搜索面板单击一个 .atb 表格开始编辑。"
      />
    );
  }
  return <TableEditor key={currentTableFile} />;
}
