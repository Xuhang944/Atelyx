/**
 * 图片放大预览（Lightbox）。
 *
 * 表格图片单元格点击缩略图弹出：全屏遮罩 + 居中大图（保持比例）+ 左右切换（循环）+
 * Esc/点击遮罩关闭。纯视觉组件，图片 dataURL 由调用方传入，无额外加载。
 */
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";

interface Props {
  /** 图片 dataURL 数组（当前单元格的全部图片）。 */
  images: string[];
  /** 初始显示下标。 */
  index: number;
  /** 切换图片（受控：父级更新 index）。 */
  onIndexChange: (i: number) => void;
  onClose: () => void;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: Props) {
  const count = images.length;
  // Esc 关闭（监听挂载期间）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && count > 1) onIndexChange((index - 1 + count) % count);
      if (e.key === "ArrowRight" && count > 1) onIndexChange((index + 1) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onIndexChange, index, count]);

  return (
    <div
      data-lightbox
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={onClose}
    >
      <img
        src={images[index]}
        alt="放大预览"
        className="max-w-[90vw] max-h-[90vh] object-contain select-none"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
      {/* 顶部关闭 */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded hover:bg-white/10"
        style={{ color: "var(--text-primary)" }}
        title="关闭 (Esc)"
      >
        <X size={20} />
      </button>
      {/* 左右切换（仅多图时显示；循环） */}
      {count > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((index - 1 + count) % count);
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
            style={{ color: "var(--text-primary)" }}
            title="上一张 (←)"
          >
            <ChevronLeft size={24} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((index + 1) % count);
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
            style={{ color: "var(--text-primary)" }}
            title="下一张 (→)"
          >
            <ChevronRight size={24} />
          </button>
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-xs"
            style={{ background: "rgba(0,0,0,0.6)", color: "var(--text-primary)" }}
          >
            {index + 1} / {count}
          </div>
        </>
      )}
    </div>
  );
}
