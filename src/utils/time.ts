/**
 * 时间显示工具（主页面板共用：相对时间 + 两位补零）。
 */

/** 两位补零（1 → "01"）。 */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 相对时间（刚刚/分钟/小时/天；超过 30 天显示日期）。 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
