/**
 * 全仓库标签词汇表（tags 输入候选）：笔记编辑器属性区与属性面板共用。
 * 懒加载一次（Rust 侧指纹缓存保证扫描开销可控），失败静默降级空数组（仍可手输标签）。
 */
import { useCallback, useMemo, useRef } from "react";
import { useVaultStore } from "@/stores/vaultStore";

export function useVaultTagCandidates(): {
  /** tags 值输入候选（空数组 = 暂无候选）。 */
  tagCandidates: string[];
  /** 候选首次打开时触发加载（幂等，只加载一次）。 */
  requestTagCandidates: () => void;
} {
  const vaultTags = useVaultStore((s) => s.vaultTags);
  const tagCandidates = useMemo(() => (vaultTags ?? []).map((t) => t.tag), [vaultTags]);
  const requestedRef = useRef(false);
  const requestTagCandidates = useCallback(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void useVaultStore.getState().loadVaultTags();
  }, []);
  return { tagCandidates, requestTagCandidates };
}
