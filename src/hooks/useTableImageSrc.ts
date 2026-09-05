/**
 * 表格图片条目 → 显示 dataURL：路径经 `tableImageCache` 解析（缓存命中立即渲染，
 * 未命中异步读取完成后回填；遗留内嵌 dataURL 条目原样透传）。失败/空条目返回 null（调用方占位）。
 * ImageCell 当前图共用；表格视图插件（如官方时间线）经插件 facade 的 `resolveTableImage` 走同一 cache。
 *
 * 组件不直接调 service：预览批量解析与多图预载也经本文件导出（`resolveTableImageEntries`/`resolveTableImageEntry`）。
 */
import { useEffect, useState } from "react";
import { resolveTableImageUrl } from "@/services/tableImageCache";

/** 批量解析图片条目（放大预览整组打开用）：data: 透传与路径缓存统一在 cache 层。 */
export function resolveTableImageEntries(entries: string[]): Promise<string[]> {
  return Promise.all(entries.map((e) => resolveTableImageUrl(e)));
}

/** 单条解析（多图单元格预载逐条容错用：单条失败不拖累其余条目）。 */
export { resolveTableImageUrl as resolveTableImageEntry };

export function useTableImageSrc(entry: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!entry) {
      setSrc(null);
      return;
    }
    if (entry.startsWith("data:")) {
      // 遗留内嵌 dataURL：同步透传（cache 层同样透传，此处省一次异步渲染往返）
      setSrc(entry);
      return;
    }
    setSrc(null);
    resolveTableImageUrl(entry)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [entry]);
  return src;
}