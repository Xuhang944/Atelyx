/**
 * 防抖持久化控制器：统一各 store 的「变更 → debounce 写盘」样板（timer 管理 + 代数防吞）。
 * 语义对齐画布既有实现：写盘期间若又有新变更（schedule 再次被调），persist 回调对比
 * 「开始写盘时的 version」判断本轮是否生效——变了 = 保留脏标记，由下一轮 timer 再写，
 * 防写盘成功回调吞掉新编辑（各 store 此前为三份不同实现，统一收敛于此）。
 *
 * 各 store 保留自有语义（dirty 判定 / 乐观锁 / watcher 回环抑制 / 仓库归属校验），写在 persist 回调里。
 */
export interface PersistController<T = unknown> {
  /** 变更后调度：代数 +1 并重置 debounce timer（timer 到点调 persist()，extra 为 undefined）。 */
  schedule(): void;
  /** 清除未到期的调度（load/clear/外部刷新前调用，防旧 timer 重写新状态）。 */
  cancel(): void;
  /** 立即持久化（timer 到点与外部 flush 共用）：清 timer 后调 persist(extra)。 */
  flush(extra?: T): Promise<void>;
  /** 变更代数：schedule 每次 +1；persist 回调写盘前捕获、完成后对比。 */
  readonly version: number;
}

export function createPersistController<T = unknown>(opts: {
  /** 实际写盘（各 store 实现；timer 到点传 undefined，外部 flush 透传 extra）。 */
  persist: (extra: T | undefined) => Promise<void>;
  /** debounce 间隔毫秒（缺省 500）。 */
  delay?: number;
  /** schedule 时同步执行（置 saving/dirty 等瞬时状态）。 */
  beforeSchedule?: () => void;
}): PersistController<T> {
  const delay = opts.delay ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let version = 0;
  return {
    schedule() {
      version++;
      opts.beforeSchedule?.();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void opts.persist(undefined);
      }, delay);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush(extra) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return opts.persist(extra);
    },
    get version() {
      return version;
    },
  };
}
