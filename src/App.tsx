import { lazy, Suspense, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { LoadingScreen } from "@/components/common/LoadingScreen";
import { useVaultFileWatcher } from "@/hooks/useVaultFileWatcher";
import { checkAndAutoUpdate } from "@/services/updater";

// 页面 lazy 分割：主包不含 CodeMirror/KaTeX/高亮语言包等重库，LoadingScreen 更快出现。
// ReactFlowProvider 留在 App 层（页面组件自身的 useReactFlow hooks 需要它在组件外；
// React Flow 因 canvasStore 依赖本就在主包，不额外增加首屏体积）。
const VaultSelectPage = lazy(async () => {
  const mod = await import("@/pages/VaultSelectPage");
  return { default: mod.VaultSelectPage };
});
const ProjectWorkspacePage = lazy(async () => {
  const mod = await import("@/pages/ProjectWorkspacePage");
  return { default: mod.ProjectWorkspacePage };
});

/** 窗口形态应用串行队列：view 切换（含 booting 结束的首应用）多次触发时按序执行，
 * 最终形态 = 最后一次调用的视图（防并发乱序把工作区窗口锁成启动页形态）。
 * 队列 promise 因内层 catch 永不 reject。 */
let windowShapeQueue: Promise<void> = Promise.resolve();
function applyWindowShape(): Promise<void> {
  const s = useAppStore.getState();
  const apply = s.view === "vaultSelect" ? s.applyStartupWindow : s.applyWorkspaceWindow;
  windowShapeQueue = windowShapeQueue.then(() => apply().catch(() => {}));
  return windowShapeQueue;
}
export default function App() {
  const view = useAppStore((s) => s.view);
  const init = useAppStore((s) => s.init);
  const loadSettings = useSettingsStore((s) => s.load);
  const theme = useSettingsStore((s) => s.theme);
  const fontSize = useSettingsStore((s) => s.vaultConfig?.fontSize);
  const fontFamily = useSettingsStore((s) => s.vaultConfig?.fontFamily);

  /** 初始化未完成前渲染加载屏（循环扫光进度条），完成后按 view 渲染启动页/工作区。 */
  const [booting, setBooting] = useState(true);

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

  // 窗口形态随视图切换：启动页固定 960×640 不可调整，工作区恢复可调整（静默降级，串行队列）。
  // 窗口恒以启动页尺寸创建（tauri.conf.json），加载屏期间即小窗；booting 期间 view 变化触发的
  // applyWorkspaceWindow 幂等（窗口小于默认时才放大），booting 结束再由 applyWindowShape
  // 统一按最终视图应用一次，进入工作区全程只有一次放大。
  useEffect(() => {
    applyWindowShape();
  }, [view]);

  // 仓库文件监听：进仓库后全程订阅（工作区）。
  // vaultSelect 页未开仓库，watcher 未启动，订阅无意义。
  useVaultFileWatcher(view !== "vaultSelect");

  // 应用挂载：init 登记最近仓库（首启建默认仓库），loadSettings 重置运行时配置，
  // selectVault 进入仓库后由 loadVaultConfig 填充仓库级配置（AI 供应商/主题/搜索源 + keychain key）。
  // 记住上次所在仓库：init 返回非 null 时跳过启动页直接进入。
  useEffect(() => {
    // 预载工作区页面 chunk（lazy 在首次渲染才触发加载，booting 期间先编译/加载，切换无感）
    void import("@/pages/ProjectWorkspacePage").catch(() => {});
    let settled = false;
    // 兜底：初始化 IPC 异常挂起（如读取配置卡死）时强制结束加载屏落到启动页，防永久卡加载屏
    const fallback = setTimeout(() => {
      if (settled) return;
      void applyWindowShape().then(() => setBooting(false));
    }, 5000);
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
    })().finally(async () => {
      settled = true;
      clearTimeout(fallback);
      // 等窗口形态应用完成再结束加载屏：工作区渲染时窗口已是最终大小，防跳变
      await applyWindowShape();
      setBooting(false);
    });
  }, [init, loadSettings]);

  return (
    <ReactFlowProvider>
      <Suspense fallback={<LoadingScreen />}>
        {booting ? (
          <LoadingScreen />
        ) : view === "workspace" ? (
          <ProjectWorkspacePage />
        ) : (
          <VaultSelectPage />
        )}
      </Suspense>
    </ReactFlowProvider>
  );
}
