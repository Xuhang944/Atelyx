/**
 * 启动加载屏：窗口创建即显示（init 完成前），深色全屏 + Logo + 循环扫光进度条。
 * 扫光动画（.sweep-track/.sweep-bar）定义在 styles/index.css，纯 transform，GPU 合成。
 * 首启 → 启动页，非首启 → 工作区，均经此过渡。
 */
// 应用图标（与 src-tauri/icons/icon.svg 同源，加载屏 Logo 展示）
import appIcon from "@/assets/icon.svg";

export function LoadingScreen() {
  return (
    <div
      className="h-full flex flex-col items-center justify-center select-none"
      style={{ background: "#1e1e1e" }}
    >
      <img
        src={appIcon}
        alt="Atelyx"
        draggable={false}
        className="w-16 h-16 rounded-2xl shadow-lg ring-1 ring-white/10"
      />
      <div className="sweep-track mt-8">
        <div className="sweep-bar" />
      </div>
    </div>
  );
}
