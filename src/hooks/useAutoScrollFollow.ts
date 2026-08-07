/**
 * 智能滚动跟随：贴底时内容变化自动滚到底；用户上翻离开底部后停止跟随（流式阅读不被拉走），
 * 此时新内容到达显示「新消息」回底按钮，点击回底恢复跟随。
 * 对话节点 / AI 对话面板共用（统一调用）。
 *
 * - 距底 < 60px 视为贴底（`handleScroll` 同步判定，onScroll 触发）
 * - 自动滚底用 rAF 节流：流式高频更新时合并为一次滚动
 * - `deps` 为内容版本依赖：变化即检查跟随（节点传 `[messages]`、面板传 `[messages.length, lastContent]`）
 */
import { useEffect, useRef, useState, type RefObject } from "react";

/** 距滚动区底部此阈值内视为「贴底」，恢复跟随。 */
const NEAR_BOTTOM_THRESHOLD = 60;

export function useAutoScrollFollow(
  scrollRef: RefObject<HTMLElement | null>,
  deps: readonly unknown[]
): {
  handleScroll: () => void;
  jumpToBottom: () => void;
  showJumpToBottom: boolean;
} {
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const scrollRafRef = useRef<number | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
    stickToBottomRef.current = nearBottom;
    if (nearBottom) setShowJumpToBottom(false);
  };

  const jumpToBottom = () => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  // 自动滚到底：仅贴底时滚动跟随；上翻后新内容到达 → 显示回底按钮。rAF 节流，流式高频更新时仅末次滚动执行
  useEffect(() => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight) {
        // 内容不足一屏（切换/清空会话时 scrollTop 程序性钳制不触发 onScroll，跟随态残留）：
        // 无可滚动的底部，重置跟随并隐藏回底按钮
        stickToBottomRef.current = true;
        setShowJumpToBottom(false);
        return;
      }
      if (stickToBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight });
      } else {
        setShowJumpToBottom(true);
      }
    });
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollRef 为稳定 ref 无需依赖；deps 由调用方传内容版本（hooks 透传模式的固有跳过）
  }, deps);

  return { handleScroll, jumpToBottom, showJumpToBottom };
}
