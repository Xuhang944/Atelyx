/**
 * 笔记历史（每笔记隐藏侧文件，审计/回滚轴）。
 *
 * 磁盘仍以 `.md` 为真源；历史是独立的审计轴，存 `.atelyx/history/<encodeURIComponent(file)>.json`
 * （随仓库走、跨设备一致；`.atelyx` 隐藏目录被文件树与 watcher 排除，写历史不触发回波）。
 * 每个版本存**全文快照**（回滚即时可靠）+ 相对上一版本的行级 diff 摘要（展示「改了啥」），
 * 版本粒度 = 落盘存档点 + 外部写入 + 手动回滚 + 新建/删除（连贯编辑合并为一个存档点，不逐键）。
 *
 * 防膨胀：留存默认全留，可配 `maxVersions` 剪枝（保留最近 N 版）；diff 摘要而非整存两份正文。
 * 并发安全：读改写整文件（同事写同一侧文件为罕见边界，后写者胜，容忍偶发丢版本）。
 */
import { readVaultFile, writeVaultFile } from "@/services/vault/aiFiles";

/** 历史 version 的作者身份。 */
export interface HistoryAuthor {
  /** 稳定标识（设备名）。 */
  id: string;
  /** 显示名（协作昵称，缺省回落设备名）。 */
  name: string;
  /** 设备名。 */
  device: string;
}

/** 版本行为枚举（UI 展示 + 回滚决策）。 */
export type HistoryAction = "edit" | "restore" | "external" | "create" | "delete";

/** 一个历史版本。 */
export interface NoteHistoryVersion {
  seq: number;
  ts: number;
  author: HistoryAuthor;
  action: HistoryAction;
  /** 该版本全文快照（LF；回滚目标）。 */
  content: string;
  /** 相对上一版本的改动摘要（展示用；纯函数 diff 现算补全，见 diffSummary）。 */
  summary?: string;
  /** 补充说明（外部导入/回滚时的备注）。 */
  note?: string;
}

/** 侧文件 schema。 */
export interface NoteHistory {
  versions: NoteHistoryVersion[];
}

/** 侧文件根（隐藏目录，随仓库走）。 */
const HISTORY_DIR = ".atelyx/history";

/** 侧文件相对路径：笔记相对路径经 encodeURIComponent 摊平（防嵌套目录 + 非法字符）。 */
export function historyPathFor(file: string): string {
  return `${HISTORY_DIR}/${encodeURIComponent(file)}.json`;
}

let myAuthor: HistoryAuthor = { id: "", name: "", device: "" };
/** 设置当前作者（进入仓库/身份变化时由上层注入；未设置回落设备名）。 */
export function setHistoryAuthor(author: HistoryAuthor): void {
  myAuthor = author;
}

/** 读取侧文件版本列表；缺失/损坏 → 空数组（历史尽力而为，不阻塞编辑）。 */
export async function loadHistory(file: string): Promise<NoteHistoryVersion[]> {
  try {
    const raw = await readVaultFile(historyPathFor(file));
    const parsed = JSON.parse(raw) as NoteHistory;
    return Array.isArray(parsed.versions) ? parsed.versions : [];
  } catch {
    return [];
  }
}

/** 行级 diff：返回相对上一版本的改动行摘要文本（如 `+3 −1 行`；未变 → `未改动`）。 */
function diffSummary(prev: string, next: string): string {
  if (prev === next) return "未改动";
  const a = prev.split("\n");
  const b = next.split("\n");
  let added = 0;
  let removed = 0;
  // 简单行补齐（myers 太贵）：分别统计多出/缺失的行，足够展示「加了 N 行减了 M 行」
  const common = new Set(prev === "" ? [] : a);
  for (const line of b) if (line !== "" && !common.has(line)) added++;
  const commonB = new Set(b);
  for (const line of a) if (line !== "" && !commonB.has(line)) removed++;
  // 空行不计数；实际增删行以字数估算兜底（避免全空文件显示 0）
  if (added === 0 && removed === 0) {
    const lenDiff = next.length - prev.length;
    return lenDiff >= 0 ? `+${lenDiff} 字` : `${lenDiff} 字`;
  }
  return `${added ? `+${added} 行 ` : ""}${removed ? `−${removed} 行` : ""}`.trim();
}

/**
 * 追加一个历史版本（版本边界）。内容与上一版本相同的 no-op 直接跳过（防重复存档点）。
 * maxVersions = 0 表示全留（默认）；>0 时保留最近 N 版（剪枝，防无限膨胀）。
 * coalesceEditMs > 0 时：上一版本为连续编辑（action="edit"）且距今 < 该值 → 就地滑动更新该版本
 * （不新增 seq，保证「稳定存档点 + 最新可回滚到当下」，避免每次 500ms 防抖都加一版）。外部/回滚等
 * 显式边界不受节流影响。
 */
export async function recordHistoryVersion(
  file: string,
  opts: {
    content: string;
    action: HistoryAction;
    note?: string;
    maxVersions?: number;
    coalesceEditMs?: number;
  },
): Promise<void> {
  const versions = await loadHistory(file);
  const last = versions[versions.length - 1];
  if (last && last.content === opts.content && last.action === opts.action) return;
  const coalesce = opts.coalesceEditMs && opts.action === "edit" && last?.action === "edit";
  // 连续编辑节流：滑动更新上一版本快照（seq 不变），回滚仍可到最新
  if (coalesce && (opts.coalesceEditMs ?? 0) > 0 && Date.now() - last!.ts < (opts.coalesceEditMs ?? 0)) {
    const prev = versions[versions.length - 2]?.content ?? "";
    last!.content = opts.content;
    last!.ts = Date.now();
    last!.author = myAuthor;
    last!.summary = diffSummary(prev, opts.content);
    if (opts.note) last!.note = opts.note;
    try {
      await writeVaultFile(historyPathFor(file), JSON.stringify({ versions }));
    } catch {
      // 历史写入失败（只读/权限）不应阻塞编辑：静默降级
    }
    return;
  }
  const prevContent = last?.content ?? "";
  const version: NoteHistoryVersion = {
    seq: last ? last.seq + 1 : 1,
    ts: Date.now(),
    author: myAuthor,
    action: opts.action,
    content: opts.content,
    summary: diffSummary(prevContent, opts.content),
    ...(opts.note ? { note: opts.note } : {}),
  };
  let next = [...versions, version];
  const max = opts.maxVersions ?? 0;
  if (max > 0 && next.length > max) {
    next = next.slice(next.length - max);
  }
  try {
    await writeVaultFile(historyPathFor(file), JSON.stringify({ versions: next }));
  } catch {
    // 历史写入失败（只读/权限）不应阻塞编辑：静默降级
  }
}

/** 取指定 seq 版本的全文快照；不存在返回 null（回滚目标）。 */
export function versionContentAt(versions: NoteHistoryVersion[], seq: number): string | null {
  return versions.find((v) => v.seq === seq)?.content ?? null;
}
