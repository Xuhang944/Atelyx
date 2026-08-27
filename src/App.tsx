import { lazy, Suspense, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useVaultStore } from "@/stores/vaultStore";
import { PanelWindowRoot } from "@/components/layout/PanelWindowRoot";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LoadingScreen } from "@/components/common/LoadingScreen";
import { useAppearance } from "@/hooks/useAppearance";
import { getCurrentWindowLabel } from "@/services/window";
import { PANEL_LABEL_PREFIX, usePanelStore } from "@/stores/panelStore";

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

/** 主窗口应用主体（启动页 + 工作区 + booting 流程）。 */
function MainWorkspaceApp() {
  const view = useAppStore((s) => s.view);
  const init = useAppStore((s) => s.init);
  const loadSettings = useSettingsStore((s) => s.load);
  useAppearance();

  /** 初始化未完成前渲染加载屏（循环扫光进度条），完成后按 view 渲染启动页/工作区。 */
  const [booting, setBooting] = useState(true);

  // 窗口形态随视图切换：启动页固定 960×640 不可调整，工作区恢复可调整（静默降级，串行队列）。
  // 窗口恒以启动页尺寸创建（tauri.conf.json），加载屏期间即小窗；booting 期间 view 变化触发的
  // applyWorkspaceWindow 幂等（窗口小于默认时才放大），booting 结束再由 applyWindowShape
  // 统一按最终视图应用一次，进入工作区全程只有一次放大。
  useEffect(() => {
    applyWindowShape();
  }, [view]);

  // 窗口关闭守卫：先 flush 全部 pending 改动再真正关窗，防 debounce 窗口内丢数据（幂等注册）
  useEffect(() => {
    useAppStore.getState().installCloseGuard();
  }, []);

  // 仓库文件监听：进仓库后全程订阅（工作区），vaultSelect 页未开仓库 watcher 未启动，订阅无意义。
  // 订阅副作用归 vaultStore（分层：组件不直连 service），view 切换时启停（store 内幂等）
  useEffect(() => {
    useVaultStore.getState().startFileWatcher(view !== "vaultSelect");
  }, [view]);

  // 应用挂载：init 登记最近仓库（首启建默认仓库），loadSettings 加载应用级外观配置，
  // selectVault 进入仓库后由 loadVaultConfig 填充仓库级配置（AI 供应商/搜索源 + keychain key）。
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
      // 面板运行时初始化（协作连接改由 panelStore.syncCollabHost 按视图归属驱动）
      await usePanelStore.getState().initMain();
      if (autoEnterRoot) {
        await useAppStore.getState().selectVault(autoEnterRoot);
      }
      // 撕裂窗口恢复：在仓库打开之后重建（面板握手需仓库信息，见 panel-init 协议）
      await usePanelStore.getState().restoreDetachedWindows();
      // 自动更新（应用级，global.json）：开启时启动静默检查一次，失败静默跳过。
      // 走 store 包装（runAutoUpdate 内部先 flush 全部 pending 改动再检查安装，重启不丢数据；
      // 协作连接收尾不随 flush 执行，见 appStore.flushAllPending 注释）
      if (useAppStore.getState().autoUpdate) {
        void useAppStore.getState().runAutoUpdate();
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
    <Suspense fallback={<LoadingScreen />}>
      {booting ? (
        <LoadingScreen />
      ) : view === "workspace" ? (
        <ProjectWorkspacePage />
      ) : (
        <VaultSelectPage />
      )}
    </Suspense>
  );
}

/** 应用入口：按窗口 label 分流——主窗口走完整启动流程；撕裂窗口只渲染单面板。
 * 撕裂窗口不执行 init/selectVault/自动更新等主窗口专属逻辑（面板角色由 panelStore 管理）。
 * label 读取失败（IPC/init 脚本异常）时降级为主窗口角色并打日志，绝不白屏。 */
export default function App() {
  const [isPanel] = useState(() => {
    try {
      return getCurrentWindowLabel().startsWith(PANEL_LABEL_PREFIX);
    } catch (e) {
      console.error("读取窗口 label 失败", e);
      return false;
    }
  });

  // 全局屏蔽浏览器默认右键菜单（两窗口角色都需要）
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  return (
    <ReactFlowProvider>
      {/* 错误边界：渲染崩溃显示错误面板（可读可关窗），不白屏 */}
      <ErrorBoundary>
        {isPanel ? <PanelWindowRoot /> : <MainWorkspaceApp />}
      </ErrorBoundary>
    </ReactFlowProvider>
  );
}
