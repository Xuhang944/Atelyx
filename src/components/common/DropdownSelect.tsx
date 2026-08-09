/**
 * 通用下拉选择器（自绘弹层，替代原生 select 统一 UI 风格）。
 *
 * 受控组件：value 与选项匹配时显示该选项 label，否则显示 placeholder；
 * 「清除/空值」由调用方传 `{ value: "" }` 选项实现（与原 `<option value="">` 一一对应）。
 * 触发按钮只负责结构（flex + 箭头 + focus ring），尺寸/颜色/边框由调用方 className/style 决定。
 *
 * 弹层行为与全项目菜单一致：fixed 定位 + `useClampedMenuPosition` 视口钳制 +
 * Esc/点击面板外关闭（自监听而非 `useDismissOnOutside`：需排除自身 trigger 区域——
 * trigger 不带 stopPropagation，否则点击相邻下拉（如对话节点提示词/模型两个下拉）时
 * 事件到不了 document，前一个面板不会关闭），选项行 `hover:bg-[var(--hover)]`、
 * 选中项 accent 色 + Check（对齐 FieldMenu/RowMenu）；`group` 选项渲染分组头（对应原生 optgroup）。
 * 面板经 `createPortal` 挂 body：画布节点带 transform，fixed 会被 transform 祖先捕获错位，
 * 脱离节点 DOM 树后按视口坐标渲染；z-[1100] 高过 React Flow 选中节点的 +1000 抬升。
 */
import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** 可选分组头（对应原生 optgroup label）。 */
  group?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  /** value 为空且无对应选项时触发按钮的兜底显示。 */
  placeholder?: ReactNode;
  disabled?: boolean;
  /** 触发按钮样式（尺寸/颜色/边框等），完全覆盖组件默认结构类之外的样式。 */
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** 透传到触发按钮（如标题栏语言下拉的无障碍语义）。 */
  "aria-label"?: string;
  /** 透传到触发按钮（标题栏内使用时排除拖拽区域）。 */
  "data-tauri-drag-region"?: "true" | "false";
}

export function DropdownSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  style,
  title,
  "aria-label": ariaLabel,
  "data-tauri-drag-region": dataTauriDragRegion,
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    minWidth: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { ref: panelRef, pos } = useClampedMenuPosition(
    anchor?.x ?? 0,
    anchor?.y ?? 0,
  );
  // Esc 或点击面板/自身 trigger 之外关闭；面板内与自身 trigger 不关（toggle 交给 click）
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [panelRef]);

  const selected = options.find((o) => o.value === value);

  const onTriggerClick = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom + 2, minWidth: r.width });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={onTriggerClick}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tauri-drag-region={dataTauriDragRegion}
        className={`flex items-center gap-1 min-w-0 cursor-pointer outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
        style={style}
      >
        <span className="flex-1 min-w-0 truncate text-left">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={12} className="flex-shrink-0" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            className="fixed border rounded shadow-lg py-1 z-[1100] max-h-64 overflow-y-auto"
            style={{
              left: pos.x,
              top: pos.y,
              minWidth: anchor?.minWidth,
              background: "var(--bg-secondary)",
              borderColor: "var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {options.map((o, i) => (
              <div key={`${o.value}-${i}`}>
                {o.group && (i === 0 || options[i - 1].group !== o.group) && (
                  <div
                    className="px-3 pt-1.5 pb-0.5 text-[10px] select-none"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {o.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--hover)] inline-flex items-center justify-between gap-2"
                  style={{
                    color:
                      o.value === value
                        ? "var(--accent)"
                        : "var(--text-primary)",
                  }}
                >
                  <span className="truncate">{o.label}</span>
                  {o.value === value && (
                    <Check size={12} className="flex-shrink-0" />
                  )}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
