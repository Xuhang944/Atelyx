/**
 * 自动检查更新 service（tauri-plugin-updater + GitHub Release 静态 latest.json）。
 *
 * 调用时机：设置开启 autoUpdate 后每次启动应用一次（App.tsx 挂载后触发）。
 * 全链路静默降级：检查/下载/安装任一步失败只记日志，不弹窗、不阻塞画布，下次启动再试。
 * 签名校验由插件用 tauri.conf.json 的 pubkey 完成，校验失败拒绝安装。
 * dev 模式跳过：开发构建未打包签名产物，避免误触发下载安装。
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** 手动检查结果：null = 已是最新版本。 */
export interface UpdateCheckResult {
  latestVersion: string;
}

/** 手动检查新版本（设置页「关于」用）；检查失败抛错交由 UI 展示。 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  const update = await check();
  if (!update) return null;
  return { latestVersion: update.version };
}

/** 下载并安装新版本；成功后重启应用（失败抛错交由 UI 展示）。 */
export async function installUpdate(): Promise<void> {
  const update = await check();
  if (!update) return;
  await update.downloadAndInstall();
  await relaunch();
}

/** 启动静默自动更新链路：dev 跳过；检查/下载/安装失败静默降级（下次启动再试）。 */
export async function checkAndAutoUpdate(): Promise<void> {
  if (import.meta.env.DEV) return;
  try {
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.error("自动更新失败（静默降级，下次启动再试）", e);
  }
}
