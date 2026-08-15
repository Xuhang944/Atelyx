/**
 * 表单草稿状态 hooks（设置面板共用）：
 * - useDraftSync：本地草稿 + 外部值变化时同步（受控输入中间态防拒 + blur 提交模式）
 * - useDebouncedDraft：防抖提交草稿（拖动/连续 onChange 场景，防每帧一次原子写）
 */
import { useEffect, useRef, useState } from "react";

/** 输入草稿：本地 state + 外部值变化时同步（受控输入中间态防拒 + blur 提交模式）。
 * 注意：外部值变化会覆盖草稿（如非法输入回滚/其他面板修改配置），与既有行为一致。 */
export function useDraftSync<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return [draft, setDraft];
}

/** 防抖提交草稿：拖动/连续 onChange 场景（取色器），防抖 delay 后落盘（避免每帧一次配置原子写/relay 重连）。 */
export function useDebouncedDraft<T>(
  init: T,
  onCommit: (v: T) => void,
  delay = 200,
): [T, (v: T) => void] {
  const [draft, setDraft] = useState(init);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);
  const commit = (v: T) => {
    setDraft(v);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onCommit(v);
    }, delay);
  };
  return [draft, commit];
}
