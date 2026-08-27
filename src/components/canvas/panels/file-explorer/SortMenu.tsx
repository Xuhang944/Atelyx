import { Check } from "lucide-react";
import { Menu, MenuItem } from "@/components/common/Menu";
import { SORT_OPTIONS } from "./sort";
import type { FileExplorerSortKey } from "@/types";

/** 排序方式下拉气泡（图标按钮触发；点击外部/Esc 关闭，当前项打勾）。 */
export function SortMenu({
  x,
  y,
  value,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  value: FileExplorerSortKey;
  onChange: (key: FileExplorerSortKey) => void;
  onClose: () => void;
}) {
  return (
    <Menu x={x} y={y} onClose={onClose} widthClass="w-44" stopPointerDown>
      {SORT_OPTIONS.map((o) => (
        <MenuItem key={o.key} onClick={() => onChange(o.key)}>
          <span className="flex-1">{o.label}</span>
          {value === o.key && <Check size={12} style={{ color: "var(--accent)" }} />}
        </MenuItem>
      ))}
    </Menu>
  );
}
