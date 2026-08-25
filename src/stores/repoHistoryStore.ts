/**
 * 仓库历史只读聚合 store（主页「仓库历史」面板 + 日历活动计数共用数据源）。
 *
 * 数据来自 `services/home.listRepoHistory`（Rust 聚合 `.atelyx/history/`）：
 * - `entries`：版本流（ts 倒序、上限）→ 仓库历史面板；
 * - `dailyCounts`：全量版本按日计数 → 日历活动密度。
 * 切仓库时由面板经 vaultId effect 触发重载（load 先清空防旧仓库数据闪现）。
 * 加载失败静默降级为空（尽力而为，不阻塞面板）。
 */
import { create } from "zustand";
import { listRepoHistory, type DailyCount, type RepoHistoryEntry } from "@/services/home";
import { useAppStore } from "@/stores/appStore";

interface RepoHistoryState {
  loading: boolean;
  /** 版本流（ts 倒序，上限）。 */
  entries: RepoHistoryEntry[];
  /** 按日版本计数（活动日历）。 */
  dailyCounts: DailyCount[];
  /** 重载（切仓库/面板挂载时调用）。 */
  load: () => Promise<void>;
}

/** 加载代数：切仓库时旧请求在途 → 递增代数使其结果作废（loading 恒由最新代数复位，防卡死）。 */
let loadSeq = 0;

export const useRepoHistoryStore = create<RepoHistoryState>((set) => ({
  loading: false,
  entries: [],
  dailyCounts: [],
  load: async () => {
    const vaultId = useAppStore.getState().vaultId;
    if (!vaultId) return;
    const seq = ++loadSeq;
    set({ loading: true, entries: [], dailyCounts: [] });
    try {
      const res = await listRepoHistory();
      // 竞态守卫：等待期间已触发新加载（seq 落后）或已切仓库 → 丢弃陈旧结果
      if (seq !== loadSeq || useAppStore.getState().vaultId !== vaultId) return;
      set({ entries: res.entries, dailyCounts: res.dailyCounts });
    } catch (e) {
      console.error("加载仓库历史失败", e);
      if (seq === loadSeq) set({ entries: [], dailyCounts: [] });
    } finally {
      // 无条件复位 loading：即使本请求已作废，也让后续 load 能重新调度（防永久「加载中」）
      if (seq === loadSeq) set({ loading: false });
    }
  },
}));
