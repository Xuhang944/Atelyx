/**
 * 应用元信息 service（版本号等）。
 */
import { getVersion } from "@tauri-apps/api/app";

/** 读取应用版本号（tauri.conf.json version）。 */
export function getAppVersion(): Promise<string> {
  return getVersion();
}
