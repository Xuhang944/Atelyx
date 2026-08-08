import { ArrowLeft, BookmarkPlus, ClipboardCopy, Table as TableIcon, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useTableStore } from "@/stores/tableStore";
import { useVaultStore } from "@/stores/vaultStore";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";
import { OPEN_TABLE_EVENT } from "@/components/canvas/nodes/TableNode";
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
  const tableList = useVaultStore((s) => s.tableList);
  // 画布内文本节点（无 file）提供「保存为笔记」入口：落盘生成仓库 .md 并转笔记节点
  const node = nodes.find((n) => n.id === nodeId);
  const isUnsavedText = node?.type === "text" && !(node.data as unknown as TextData).file;
  // 对话节点提供「生成到表格」（AI 填行：选仓库内目标表）
  const isConversation = node?.type === "conversation";
  /** 选择目标表浮层（菜单内切换，同画布右键菜单 linkMode 模式） */
  const [picking, setPicking] = useState(false);

  // 挂载后按菜单实测尺寸钳制到视口内（防靠近窗口右/下边缘被截断）
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y, [picking]);

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

  /** 选定目标表：AI 按该表字段生成行并追加，成功后打开表格窗口；失败画布错误条提示。 */
  const handleGenerateRows = useCallback(
    async (file: string, name: string) => {
      onClose();
      const convData = node?.data as unknown as { providerId?: string; model?: string } | undefined;
      const messages = useCanvasStore.getState().messagesByConv[nodeId] ?? [];
      const result = await useTableStore
        .getState()
        .generateRowsFromConversation(
          file,
          convData ? { providerId: convData.providerId, model: convData.model } : null,
          messages,
        );
      if (result.ok) {
        window.dispatchEvent(
          new CustomEvent(OPEN_TABLE_EVENT, { detail: { file, title: name.replace(/\.atb$/i, "") } }),
        );
      } else {
        useCanvasStore.setState({ error: `生成到表格失败：${result.reason ?? "未知错误"}` });
      }
    },
    [nodeId, node, onClose],
  );

  return (
    <div
      ref={menuRef}
      className="fixed border rounded shadow-lg py-1 z-50 w-56"
      style={{
        left: pos.x,
        top: pos.y,
        background: "var(--bg-secondary)",
        borderColor: "var(--border)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {picking ? (
        /* 选择目标表格：列出仓库内 .atb（AI 按该表字段填行，追加语义） */
        <>
          <button
            onClick={() => setPicking(false)}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <ArrowLeft size={14} /> 返回
            </span>
          </button>
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
          {tableList.length === 0 ? (
            <div className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
              仓库暂无表格，请先在文件面板新建表格。
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {tableList.map((t) => (
                <button
                  key={t.file}
                  onClick={() => void handleGenerateRows(t.file, t.name)}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                  style={{ color: "var(--text-primary)" }}
                  title="AI 按该表字段生成行并追加"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0 w-full">
                    <TableIcon size={14} className="flex-shrink-0" />
                    <span className="truncate">{t.name.replace(/\.atb$/i, "")}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
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
          {isConversation && (
            <>
              <button
                onClick={() => setPicking(true)}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
                title="按所选表格的字段，用本对话内容生成行数据并追加"
              >
                <span className="inline-flex items-center gap-1.5">
                  <TableIcon size={14} />
                  生成到表格
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
        </>
      )}
    </div>
  );
}
