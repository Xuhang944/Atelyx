/**
 * 日历（主页）store：手动日程（`.atelyx/calendar.json` 仓库级）+ 带日期笔记（只读）。
 *
 * 手动日程 CRUD 防抖落盘；写盘按「已加载仓库」归属校验（loadedForVault），
 * 切仓库前须先 flush（appStore.selectVault 已接）防防抖窗口内把旧仓库日程写进新仓库。
 * 带日期笔记来自 `services/home.listDatedNotes`（frontmatter date/due），随 load 一并刷新。
 * 加载失败静默降级为空（尽力而为，不阻塞面板）。
 */
import { create } from "zustand";
import { CALENDAR_FILE, CALENDAR_SCHEMA } from "@/constants/calendar";
import { readVaultFile, writeVaultFile } from "@/services/vault/aiFiles";
import { listDatedNotes, type DatedNote } from "@/services/home";
import { createPersistController } from "@/utils/persist";
import { useAppStore } from "@/stores/appStore";
import type { CalendarItem } from "@/types";

/** `.atelyx/calendar.json` 磁盘格式。 */
interface CalendarFile {
  schema: typeof CALENDAR_SCHEMA;
  items: CalendarItem[];
}

interface CalendarState {
  items: CalendarItem[];
  datedNotes: DatedNote[];
  /** 已加载的仓库 id（null = 未加载；persist 归属校验用）。 */
  loadedForVault: string | null;
  /** 重载（切仓库/面板挂载时调用；先清空防旧仓库数据闪现）。 */
  load: () => Promise<void>;
  addItem: (date: string, title: string, note?: string, color?: string) => void;
  updateItem: (
    id: string,
    patch: Partial<Pick<CalendarItem, "date" | "title" | "note" | "color">>,
  ) => void;
  removeItem: (id: string) => void;
  /** 立即落盘（切仓库/退出前 flush，防 debounce 窗口内丢改动）。 */
  flush: () => Promise<void>;
}

/** 读手动日程（缺失/损坏 → 空列表）。 */
async function readCalendarItems(): Promise<CalendarItem[]> {
  try {
    const raw = await readVaultFile(CALENDAR_FILE);
    const parsed = JSON.parse(raw) as CalendarFile;
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

const persistCtl = createPersistController({
  persist: async () => {
    const s = useCalendarStore.getState();
    // 跨仓库守卫：未加载（首启/已清空）不写
    if (!s.loadedForVault) return;
    try {
      const payload: CalendarFile = { schema: CALENDAR_SCHEMA, items: s.items };
      await writeVaultFile(CALENDAR_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.error("保存日历日程失败", e);
    }
  },
  delay: 400,
});

export const useCalendarStore = create<CalendarState>((set) => ({
  items: [],
  datedNotes: [],
  loadedForVault: null,

  load: async () => {
    const vaultId = useAppStore.getState().vaultId;
    if (!vaultId) return;
    // 清残留 debounce：切仓库前 selectVault 已 flush，此处双保险防旧 timer 写新仓库
    persistCtl.cancel();
    set({ loadedForVault: null, items: [], datedNotes: [] });
    try {
      const [items, datedNotes] = await Promise.all([readCalendarItems(), listDatedNotes()]);
      // 竞态守卫：等待期间用户可能已切仓库
      if (useAppStore.getState().vaultId !== vaultId) return;
      set({ items, datedNotes, loadedForVault: vaultId });
    } catch (e) {
      console.error("加载日历失败", e);
      if (useAppStore.getState().vaultId === vaultId) {
        set({ items: [], datedNotes: [], loadedForVault: vaultId });
      }
    }
  },

  addItem: (date, title, note, color) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const item: CalendarItem = {
      id: crypto.randomUUID(),
      date,
      title: trimmed,
      ...(note?.trim() ? { note: note.trim() } : {}),
      ...(color ? { color } : {}),
      createdAt: Date.now(),
    };
    set((s) => ({ items: [...s.items, item] }));
    persistCtl.schedule();
  },

  updateItem: (id, patch) => {
    set((s) => ({
      items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
    persistCtl.schedule();
  },

  removeItem: (id) => {
    set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    persistCtl.schedule();
  },

  flush: async () => {
    await persistCtl.flush();
  },
}));
