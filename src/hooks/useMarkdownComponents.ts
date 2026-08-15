/**
 * Markdown 渲染组件配置 hook：四个调用方（对话节点 / 文本节点 / 笔记预览 / AI 对话面板）共用。
 *
 * 统一三件事：
 * - useMemo 稳定化 components 对象（气泡 memo 生效前提——ChatMessageBubble 以引用相等跳过重渲染）
 * - 无画布场景（笔记预览/AI 面板）缺省「不定位」no-op（稳定引用，不随渲染重建）
 * - 外部链接打开统一经 appStore 转发系统浏览器（模块级稳定函数，调用方不再各自写内联箭头）
 *
 * locate 回调须由调用方稳定化（useWikiNodeLocate / useVaultLinkHandlers 提供），
 * 传新的对象字面量无妨——hook 只把其中的函数拆出来进依赖。
 */
import { useMemo } from "react";
import type { Components } from "react-markdown";
import { markdownComponents } from "@/utils/markdown";
import { useAppStore } from "@/stores/appStore";

/** 无画布场景（笔记预览/AI 面板）：wiki 链接不可定位，一律走打开笔记。 */
const NOOP_LOCATABLE = (): boolean => false;
const NOOP_LOCATE = (): void => {};

/** 外部链接打开：经 appStore 转发系统浏览器（模块级稳定引用，防 components 对象每次重建）。 */
const openExternalUrl = (url: string): void => {
  void useAppStore.getState().openUrl(url);
};

export function useMarkdownComponents(opts: {
  /** 画布内 wiki 定位能力（对话/文本节点传；无画布场景不传 = 链接走打开笔记）。 */
  locate?: { isLocatable: (name: string) => boolean; onLocate: (name: string) => void };
  onOpenNote: (name: string) => void;
  isVaultPathNote: (href: string) => boolean;
  onOpenVaultPathNote: (href: string) => void;
  onCreateNote: (name: string) => void;
}): Components {
  const { locate, onOpenNote, isVaultPathNote, onOpenVaultPathNote, onCreateNote } = opts;
  const isLocatable = locate?.isLocatable ?? NOOP_LOCATABLE;
  const onLocate = locate?.onLocate ?? NOOP_LOCATE;
  return useMemo(
    () =>
      markdownComponents({
        isLocatable,
        onLocate,
        onOpenNote,
        isVaultPathNote,
        onOpenVaultPathNote,
        onCreateNote,
        onOpenUrl: openExternalUrl,
      }),
    [isLocatable, onLocate, onOpenNote, isVaultPathNote, onOpenVaultPathNote, onCreateNote],
  );
}
