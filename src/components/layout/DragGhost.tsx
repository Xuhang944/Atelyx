/**
 * 拖拽 ghost 影子：拖拽标签时显示跟随鼠标的半透明标签预览。
 *
 * 各窗口各自渲染一份：把「当前活跃拖拽的屏幕坐标」（panelStore.dragGhost，各窗口从
 * 广播同步）换算为本地 client 坐标，仅在坐标位于本窗口视口内时显示——跨窗口拖动时
 * 影子跟随光标所在窗口；拖到桌面（无窗口）时影子不显示（Tauri 无跨窗口层叠能力）。
 */
import { usePanelStore } from "@/stores/panelStore";
import { VIEW_META } from "@/components/layout/ViewHost";
import { VIEW_LABELS } from "@/constants/views";

export function DragGhost() {
  const ghost = usePanelStore((s) => s.dragGhost);
  const windowPos = usePanelStore((s) => s.windowPos);
  if (!ghost) return null;
  const x = ghost.x - windowPos.x;
  const y = ghost.y - windowPos.y;
  // 超出本窗口视口（光标在别处）→ 本窗口不显示
  if (x < -50 || y < -50 || x > window.innerWidth + 50 || y > window.innerHeight + 50) return null;
  const meta = VIEW_META[ghost.view];
  return (
    <div
      style={{
        position: "fixed",
        left: x + 14,
        top: y + 18,
        pointerEvents: "none",
        zIndex: 60,
        opacity: 0.85,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--accent)",
          color: "var(--text-primary)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        }}
      >
        {meta.icon}
        <span className="whitespace-nowrap">{VIEW_LABELS[ghost.view]}</span>
      </div>
    </div>
  );
}
