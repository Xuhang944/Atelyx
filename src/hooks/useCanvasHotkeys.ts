import { useEffect } from "react";
import { useCanvasStore } from "@/stores/canvasStore";

/**
 * 画布快捷键。
 * 在 ProjectWorkspacePage 中调用一次即可。
 * 输入框/文本区聚焦时自动跳过快捷键。
 */
function isInputTarget(e: KeyboardEvent) {
  return (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement ||
    (e.target as HTMLElement)?.isContentEditable
  );
}

export function useCanvasHotkeys(onEscape?: () => void, enabled = true) {
  const getState = useCanvasStore.getState;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputTarget(e)) return;

      const store = getState();
      const { nodes, edges, onNodesChange, onEdgesChange, deleteSelected, undo, redo } = store;

      switch (e.key) {
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          deleteSelected();
          break;
        }

        case "Escape": {
          if (nodes.some((n) => n.selected) || edges.some((e) => e.selected)) {
            onNodesChange(
              nodes
                .filter((n) => n.selected)
                .map((n) => ({ type: "select", id: n.id, selected: false }))
            );
            onEdgesChange(
              edges
                .filter((e) => e.selected)
                .map((e) => ({ type: "select", id: e.id, selected: false }))
            );
          }
          onEscape?.();
          break;
        }

        case "z":
        case "Z": {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            undo();
          }
          break;
        }

        case "y":
        case "Y": {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            redo();
          }
          break;
        }

        case "a":
        case "A": {
          if ((e.ctrlKey || e.metaKey) && nodes.length > 0) {
            e.preventDefault();
            onNodesChange(
              nodes.map((n) => ({ type: "select", id: n.id, selected: true }))
            );
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape, getState, enabled]);
}
