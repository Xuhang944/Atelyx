import { useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { VaultSelectPage } from "@/pages/VaultSelectPage";
import { ProjectWorkspacePage } from "@/pages/ProjectWorkspacePage";
import { useVaultFileWatcher } from "@/hooks/useVaultFileWatcher";
import { checkAndAutoUpdate } from "@/services/updater";

/** 按当前视图应用窗口形态 → 显示。各步独立降级：形态失败不连带跳过显示。
 * 屏幕居中由窗口创建时 `center: true` 保证（tao 原生，见 tauri.conf.json），前端不再移动窗口。 */
function applyShapeAndShow(): void {
  const s = useAppStore.getState();
  void (async () => {
    const apply = s.view === "vaultSelect" ? s.applyStartupWindow : s.applyWorkspaceWindow;
    await apply().catch(() => {});
    await s.showWindow().catch(() => {});
  })();
}

export default function App() {
  const view = useAppStore((s) => s.view);
  const currentCanvasId = useAppStore((s) => s.currentCanvasId);
  const currentCanvasFile = useAppStore((s) => s.currentCanvasFile);
  const init = useAppStore((s) => s.init);
  const loadSettings = useSettingsStore((s) => s.load);
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.vaultConfig?.fontSize);
  const fontFamily = useSettingsStore((s) => s.vaultConfig?.fontFamily);

  // 跟随系统主题：监听 prefers-color-scheme 变化（theme === "system" 时实时生效）
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effectiveTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  // 主题 class 应用（分层：store 只存状态，DOM 副作用归页面层）
  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
  }, [effectiveTheme]);

  // 字体（仓库级）：覆盖 :root font-size / font-family，空值回默认（CSS 默认）
  useEffect(() => {
    const root = document.documentElement;
    root.style.fontSize = fontSize ? `${fontSize}px` : "";
    root.style.fontFamily = fontFamily ?? "";
  }, [fontSize, fontFamily]);

  // 全局屏蔽浏览器默认右键菜单：未定义自定义菜单的区域无任何反应。
  // 已定义自定义菜单的区域（画布空白/节点/消息区/文件面板行等）自行 preventDefault，不受影响。
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  // 窗口形态随视图切换：启动页固定 960×640 不可调整，工作区恢复可调整（静默降级）。
  // 启动页内容按固定窗口设计，窗口不可调整避免布局变形。
  // 首次渲染跳过：窗口隐藏期由初始化链路统一应用最终形态（applyShapeAndShow），
  // 避免 mount 时的 applyStartupWindow 与初始化链并发导致最终形态被旧调用覆盖。
  const firstViewApply = useRef(true);
  useEffect(() => {
    if (firstViewApply.current) {
      firstViewApply.current = false;
      return;
    }
    const apply =
      view === "vaultSelect"
        ? useAppStore.getState().applyStartupWindow
        : useAppStore.getState().applyWorkspaceWindow;
    void apply().catch(() => {});
  }, [view]);

  // 仓库文件监听：进仓库后全程订阅（工作区）。
  // vaultSelect 页未开仓库，watcher 未启动，订阅无意义。
  useVaultFileWatcher(view !== "vaultSelect");

  // 应用挂载：init 登记最近仓库（首启建默认仓库），loadSettings 重置运行时配置，
  // selectVault 进入仓库后由 loadVaultConfig 填充仓库级配置（AI 供应商/主题/搜索源 + keychain key）。
  // 记住上次所在仓库：init 返回非 null 时跳过启动页直接进入。
  // 窗口启动时隐藏（visible: false）：初始化完成后才显示——非首启自动进入工作区时，
  // 窗口直接以工作区形态（1440×900 可调整）出现，避免先闪小窗口启动页再跳变的闪烁。
  useEffect(() => {
    let settled = false;
    // 兜底：初始化异常挂起（如读取配置卡死）时按当前形态强制显示窗口，防无窗口可用
    const fallback = setTimeout(() => {
      if (!settled) applyShapeAndShow();
    }, 3000);
    void (async () => {
      const autoEnterRoot = await init();
      await loadSettings();
      if (autoEnterRoot) {
        await useAppStore.getState().selectVault(autoEnterRoot);
      }
      // 自动更新（应用级，global.json）：开启时启动静默检查一次，失败静默跳过
      if (useAppStore.getState().autoUpdate) {
        void checkAndAutoUpdate().catch(() => {});
      }
    })().finally(() => {
      clearTimeout(fallback);
      settled = true;
      // 窗口以最终形态一次性出现在屏幕中心（view 此时已确定）
      applyShapeAndShow();
    });
  }, [init, loadSettings]);

  return (
    <ReactFlowProvider>
      {view === "workspace" ? (
        <ProjectWorkspacePage canvasId={currentCanvasId} canvasFile={currentCanvasFile} />
      ) : (
        <VaultSelectPage />
      )}
    </ReactFlowProvider>
  );
}
