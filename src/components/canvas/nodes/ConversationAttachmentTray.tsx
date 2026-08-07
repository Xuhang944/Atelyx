import { AlertTriangle, FileText, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "@/types";

/**
 * 待发送附件托盘（临时附件通道）。
 * 纯展示组件：缩略图 chip 列表 + 移除；chip 右键「固定到画布」（仅无源附件）。
 */
interface Props {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  onPin: (att: PendingAttachment) => void;
}

export function ConversationAttachmentTray({ attachments, onRemove, onPin }: Props) {
  const [menu, setMenu] = useState<{ att: PendingAttachment; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 外部点击 / Esc 关闭菜单（与 ConversationNode 的 confirmMenu 同款）
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (attachments.length === 0) return null;

  return (
    <div className="nodrag relative flex flex-wrap gap-1.5 px-2 pt-1.5">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="relative group/att border rounded flex items-center gap-1.5 px-1.5 py-1 text-xs"
          style={{ background: "var(--bg-tertiary)", borderColor: "var(--border)" }}
          title={att.filename ?? ""}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (att.sourceNodeId) return;
            // 菜单 absolute 相对托盘根定位，避免 React Flow transform 容器下 fixed 漂移
            const rect = e.currentTarget.offsetParent?.getBoundingClientRect();
            setMenu({ att, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
          }}
        >
          {att.kind === "image" && att.payload ? (
            <img
              src={att.payload}
              alt=""
              className="h-8 w-8 object-cover rounded"
              draggable={false}
            />
          ) : (
            <FileText size={18} className="flex-shrink-0" />
          )}
          <span className="max-w-28 truncate">
            {att.filename || (att.kind === "image" ? "图片" : "文件")}
          </span>
          {att.parseFailed && <AlertTriangle size={12} style={{ color: "#f87171" }} />}
          <button
            onClick={() => onRemove(att.id)}
            className="hover:opacity-70 flex-shrink-0"
            title={att.sourceNodeId ? "取消引用（断开边）" : "移除附件"}
          >
            <X size={12} />
          </button>
        </div>
      ))}

      {menu && (
        <div
          ref={menuRef}
          className="absolute z-[60] border rounded shadow-lg py-1 w-40"
          style={{
            left: menu.x,
            top: menu.y,
            background: "var(--bg-secondary)",
            borderColor: "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onPin(menu.att);
              setMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Pin size={14} />
              固定到画布
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
