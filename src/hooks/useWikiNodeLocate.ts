/**
 * 画布内 wiki 链接定位：`[[笔记名]]` 命中画布上引用该笔记的文本节点 → fitView 定位。
 *
 * 画布组件专用（依赖 useReactFlow）；笔记编辑器 / AI 对话面板不做定位，只用
 * useVaultLinkHandlers 的打开/新建（markdown 组件装配时传 `isLocatable: () => false`）。
 */
import { useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useVaultStore } from "@/stores/vaultStore";
import { wikiNoteFileCandidates } from "@/utils/markdown";

export function useWikiNodeLocate() {
  const { fitView } = useReactFlow();

  const findWikiNodeId = useCallback((value: string): string | null => {
    const store = useCanvasStore.getState();
    const noteList = useVaultStore.getState().noteList;
    for (const candidate of wikiNoteFileCandidates(value)) {
      const hit = noteList.find((n) => n.name === candidate);
      if (hit) {
        const id = store.findTextNoteByFile(hit.file);
        if (id) return id;
      }
    }
    return null;
  }, []);

  const isWikiLocatable = useCallback(
    (value: string) => findWikiNodeId(value) != null,
    [findWikiNodeId]
  );

  const handleLocateWiki = useCallback(
    (value: string) => {
      const nodeId = findWikiNodeId(value);
      if (nodeId) fitView({ nodes: [{ id: nodeId }], duration: 200, padding: 0.2 });
    },
    [findWikiNodeId, fitView]
  );

  return { isWikiLocatable, handleLocateWiki };
}
