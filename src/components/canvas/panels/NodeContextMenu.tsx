import { BookmarkPlus, ClipboardCopy, Trash2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import type { TextData } from "@/types";

interface Props {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function NodeContextMenu({ nodeId, x, y, onClose }: Props) {
  const addNode = useCanvasStore((s) => s.addNode);
  const nodes = useCanvasStore((s) => s.nodes);
  // 画布内文本节点（无 file）提供「保存为笔记」入口：落盘生成仓库 .md 并转笔记节点
  const node = nodes.find((n) => n.id === nodeId);
  const isUnsavedText = node?.type === "text" && !(node.data as unknown as TextData).file;

  // 挂载后按菜单实测尺寸钳制到视口内（防靠近窗口右/下边缘被截断）
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y);

  useEffect(() => {
    const close = (e: KeyboardEvent | MouseEvent) => {
      if (e instanceof KeyboardEvent && e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const handleSaveAsNote = useCallback(() => {
    void useVaultStore
      .getState()
      .saveTextNodeAsNote(nodeId)
      .catch(() => useCanvasStore.setState({ error: "保存为笔记失败，请重试" }));
    onClose();
  }, [nodeId, onClose]);

  const handleDelete = useCallback(() => {
    const { onNodesChange, pushUndo } = useCanvasStore.getState();
    // 右键删除需入栈，否则无法 Ctrl+Z 撤销
    pushUndo();
    onNodesChange([{ type: "remove" as const, id: nodeId }]);
    onClose();
  }, [nodeId, onClose]);

  const handleDuplicate = useCallback(() => {
    const original = nodes.find((n) => n.id === nodeId);
    if (!original) return;
    const newNode = {
      ...original,
      id: crypto.randomUUID(),
      position: {
        x: original.position.x + 40,
        y: original.position.y + 40,
      },
      selected: false,
      // 深拷贝 data，避免与源节点共享内部引用（如数组字段）
      data: structuredClone(original.data),
    };
    addNode(newNode);
    onClose();
  }, [nodeId, nodes, addNode, onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-44"
      style={{
        left: pos.x,
        top: pos.y,
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {isUnsavedText && (
        <>
          <button
            onClick={handleSaveAsNote}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <BookmarkPlus size={14} />
              保存为笔记
            </span>
          </button>
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
        </>
      )}
      <button
        onClick={handleDuplicate}
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
        style={{ color: "var(--text-primary)" }}
      >
        <span className="inline-flex items-center gap-1.5">
          <ClipboardCopy size={14} />
          复制节点
        </span>
      </button>
      <hr className="my-1" style={{ borderColor: "var(--border)" }} />
      <button
        onClick={handleDelete}
        className="w-full text-left px-3 py-1.5 text-sm text-[#f87171] hover:bg-red-600 hover:text-white"
      >
        <span className="inline-flex items-center gap-1.5">
          <Trash2 size={14} />
          删除节点
        </span>
      </button>
    </div>
  );
}
