/**
 * 全局配置 service。
 *
 * 读写 `app_data_dir/global.json`，对应 Rust `commands/global.rs`。
 * 承载：最近打开仓库列表 + 本设备 ID（主题等仓库级配置已移入各仓库）。
 * recentVaults 的去重/排序/截断逻辑在此层维护（Rust 只做整文件读写）。
 *
 * **写入走 `updateGlobalConfig`（read-modify-write + 串行化）**，勿直接 `writeGlobalConfig`：
 * global.json 现由 appStore（recentVaults）、settingsStore（ai/theme）与 deviceId 共同写入，
 * 直接整体写会覆盖对方字段。`updateGlobalConfig` 只 patch 顶层字段，且通过模块级
 * promise 链串行化，避免并发 read-modify-write 丢更新。
 */
import { invoke } from "@tauri-apps/api/core";
import type { GlobalConfig, RecentVault, VaultInfo } from "@/types";

const MAX_RECENT_VAULTS = 10;

/** 读全局配置（文件不存在返回空配置）。 */
export async function readGlobalConfig(): Promise<GlobalConfig> {
  return invoke<GlobalConfig>("read_global_config");
}

// 模块级缓存：缓存 in-flight promise，并发调用共享同一次生成（首启并发调用各生成一个
// UUID 会让其中一个桶作废）；失败不缓存，下次调用重新尝试
let cachedDeviceId: Promise<string> | null = null;

/**
 * 本设备唯一 ID：首次调用生成随机 UUID 落盘 global.json（app_data_dir，不随仓库同步），
 * 之后固定返回。仓库内 `.atelyx/ui-state.json` 按它分桶隔离各设备状态
 * （见 `types/uiState.ts` 的 `perDevice`）。
 */
export function getDeviceId(): Promise<string> {
  if (!cachedDeviceId) {
    cachedDeviceId = (async () => {
      try {
        const cfg = await readGlobalConfig();
        if (cfg.deviceId) return cfg.deviceId;
        const deviceId = crypto.randomUUID();
        await updateGlobalConfig({ deviceId });
        return deviceId;
      } catch (e) {
        cachedDeviceId = null;
        throw e;
      }
    })();
  }
  return cachedDeviceId;
}

/**
 * 写全局配置（原子写，整体覆盖）。
 * **内部用**：调用方应改用 `updateGlobalConfig` 做 read-modify-write，避免覆盖其他字段。
 */
export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await invoke("write_global_config", { config });
}

/**
 * 把某仓库登记为最近打开：去重（按 root）+ 置顶 + 更新时间 + 截断上限。
 * 返回更新后的 recentVaults（调用方负责落盘）。
 */
export function bumpRecentVault(
  recentVaults: RecentVault[],
  info: VaultInfo,
  nowSec: number,
): RecentVault[] {
  const filtered = recentVaults.filter((v) => v.root !== info.root);
  return [{ root: info.root, name: info.name, lastOpenedAt: nowSec }, ...filtered].slice(
    0,
    MAX_RECENT_VAULTS,
  );
}

/** 从最近列表移除某仓库（按 root）。返回更新后的列表。 */
export function removeRecentVault(recentVaults: RecentVault[], root: string): RecentVault[] {
  return recentVaults.filter((v) => v.root !== root);
}

// ===== 写串行化 =====
// 模块级 promise 链：让并发 updateGlobalConfig 互斥执行 read-modify-write，
// 避免两个调用同时 read → 都基于旧值 merge → 后写者覆盖先写者的 patch。
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn);
  // 链不因单次失败断裂：吞掉 reject 让后续调用仍能排队
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Read-modify-write global.json：读当前值 → 浅合并 patch 顶层字段 → 写回。
 * 串行化保证并发调用不丢更新。`patch.ai` / `patch.theme` / `patch.recentVaults`
 * 整体替换对应字段（不做深合并），调用方传完整子对象。
 */
export async function updateGlobalConfig(patch: Partial<GlobalConfig>): Promise<void> {
  await serialized(async () => {
    const current = await readGlobalConfig();
    const merged: GlobalConfig = { ...current, ...patch };
    await writeGlobalConfig(merged);
  });
}

