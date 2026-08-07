/**
 * 文件面板行右键菜单：重命名 / 删除。
 *
 * 样式对齐 `NodeContextMenu`（fixed 定位、`--bg-secondary` 背景、w-44、z-50）。
 * 「删除」文字恒为红色；点击后**菜单内就地**切确认态（红色「确认删除」+「取消」），
 * 确认才执行删除——不用系统 confirm。
 *
 * 关闭：Esc / 点击菜单外（mousedown）；菜单容器 stopPropagation，防按钮点击被 document 监听抢先关闭。
 */
import { BookmarkMinus, BookmarkPlus, FileOutput, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClampedMenuPosition } from "@/hooks/useClampedMenuPosition";

interface Props {
  x: number;
  y: number;
  /** 进入 inline 重命名（复用文件面板的编辑态）。 */
  onRename: () => void;
  /** 确认删除后执行（异步删除），执行完由父级关闭菜单。 */
  onDelete: () => void | Promise<void>;
  /** 注册/注销系统提示词（仅 `.md` 行提供；undefined = 非笔记不显示该项）。 */
  onTogglePrompt?: () => void;
  /** 当前笔记是否已注册为系统提示词（决定菜单项文案与图标）。 */
  promptMarked?: boolean;
  /** 转换为画布（仅外部白板 `.canvas` 行提供；undefined = 非白板不显示该项）。 */
  onConvert?: () => void;
  onClose: () => void;
}

export function FileContextMenu({ x, y, onRename, onDelete, onTogglePrompt, promptMarked, onConvert, onClose }: Props) {
  const [confirming, setConfirming] = useState(false);
  // 父级每次渲染传新箭头函数，用 ref 存最新回调避免 document 监听反复重挂
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 挂载后按菜单实测尺寸钳制到视口内（防靠近窗口右/下边缘被截断）；
  // 依赖 confirming：删除确认态改变菜单高度，贴视口底部时需重新钳制防溢出
  const { ref: menuRef, pos } = useClampedMenuPosition(x, y, [confirming]);

  // Esc 关闭；点击菜单外关闭（mousedown 监听，容器内已 stopPropagation）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // menuRef 为稳定引用（hook 内 useRef），加入依赖仅为消除 exhaustive-deps，不会重挂监听
  }, [menuRef]);

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
      onMouseDown={(e) => e.stopPropagation()}
    >
      {confirming ? (
        // 就地确认态：红色「确认删除」+「取消」
        <div className="px-3 py-1.5">
          <p className="text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
            删除后不可恢复
          </p>
          <button
            onClick={() => {
              void onDelete();
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-sm rounded mb-1 text-[#f87171] hover:bg-red-600 hover:text-white"
          >
            <span className="inline-flex items-center gap-1.5">
              <Trash2 size={14} />
              确认删除
            </span>
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="w-full text-left px-3 py-1.5 text-sm rounded hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            取消
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={() => {
              onRename();
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
            style={{ color: "var(--text-primary)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Pencil size={14} />
              重命名
            </span>
          </button>
          {onConvert && (
            <>
              <hr className="my-1" style={{ borderColor: "var(--border)" }} />
              <button
                onClick={() => {
                  onConvert();
                  onClose();
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
                title="生成同目录 .atlx 画布副本（原文件保留）"
              >
                <span className="inline-flex items-center gap-1.5">
                  <FileOutput size={14} />
                  转换为画布
                </span>
              </button>
            </>
          )}
          {onTogglePrompt && (
            <>
              <hr className="my-1" style={{ borderColor: "var(--border)" }} />
              <button
                onClick={() => {
                  onTogglePrompt();
                  onClose();
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--accent)] hover:text-[var(--accent-fg)]"
                style={{ color: "var(--text-primary)" }}
                title={promptMarked ? "注销后不再出现在系统提示词候选中" : "注册后可作为对话/面板的系统提示词"}
              >
                <span className="inline-flex items-center gap-1.5">
                  {promptMarked ? <BookmarkMinus size={14} /> : <BookmarkPlus size={14} />}
                  {promptMarked ? "注销提示词" : "注册为提示词"}
                </span>
              </button>
            </>
          )}
          <hr className="my-1" style={{ borderColor: "var(--border)" }} />
          <button
            onClick={() => setConfirming(true)}
            className="w-full text-left px-3 py-1.5 text-sm text-[#f87171] hover:bg-red-600 hover:text-white"
          >
            <span className="inline-flex items-center gap-1.5">
              <Trash2 size={14} />
              删除
            </span>
          </button>
        </>
      )}
    </div>
  );
}
