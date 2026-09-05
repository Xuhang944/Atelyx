/**
 * 插件宿主环境探测（纯函数）。
 * 平台字符串与清单 `platforms` 取值对齐（windows-x64 / linux-x64）；未知平台返回 "unknown"
 * （安装时平台过滤对 unknown 不生效，由版本范围兜底）。
 */
export function detectPlatform(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/windows/i.test(ua)) return "windows-x64";
  if (/linux/i.test(ua)) return "linux-x64";
  return "unknown";
}
