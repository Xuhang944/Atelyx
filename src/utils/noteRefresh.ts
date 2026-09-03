/**
 * 文本节点（引用 `.md` 笔记）正文刷新的纯判定：磁盘内容变化时，决定某节点应
 * 「刷新到磁盘」还是「跳过（保留本地编辑）」。
 *
 * 背景：`refreshTextContent` 在 watcher 收到 `.md` 变化后重读磁盘。早期实现用
 * `lastWrittenMd` 基线判「自写回波跳过」，但 AI 文件写入（`writeVaultFile`）同样登记基线，
 * 造成「磁盘新于节点内存」被误判为回波而跳过刷新 → 节点保持陈旧，下次画布保存把旧正文
 * 回写覆盖 Agent 编辑。正确判据是「该节点自上次落盘（lastSavedNodes 基线）后是否改过正文」。
 *
 * 跨编辑面冲突：节点本地编辑基于的基线与磁盘不同步时（磁盘被笔记编辑器/AI 推进到
 * 节点基线之后），本地编辑是**陈旧基线上的编辑**——若画布保存把它写回，会覆盖磁盘更新的
 * 内容（笔记编辑器静默回退的根因之一）。此处统一采用「外部最新者胜」：磁盘已前进到
 * 节点基线之后 → 刷新到磁盘、丢弃陈旧基线上的本地编辑。
 */

export type TextNodeRefreshDecision = "keep" | "refresh";

/**
 * 判定单个文本节点对磁盘新内容的处理（前置条件：`current !== disk`，
 * 已一致节点由调用方在进入本函数前排除）：
 * - `saved === undefined`（新建/未落盘）：内存陈旧 → 刷新到磁盘最新。
 * - `saved === current`（自上次落盘未改过正文）：内存陈旧 → 刷新到磁盘最新
 *   （外部/AI 写入皆适用，不当作自写回波跳过）。
 * - `saved !== current`（自上次落盘改过正文 = 本地编辑）：
 *   - 磁盘仍停在节点基线（`disk === saved`）→ 本地编辑与磁盘同基线，保留（keep，
 *     随后经画布保存自然落盘，防「保存回波把新提交覆盖回旧值」的丢字竞态）；
 *   - 磁盘已前进（`disk !== saved`）→ 本地编辑基于陈旧基线，外部最新者胜：刷新到磁盘
 *     （丢弃该陈旧编辑，防回写覆盖磁盘新内容）。
 */
export function decideTextNodeRefresh(
  current: string,
  saved: string | undefined,
  disk: string,
): TextNodeRefreshDecision {
  if (saved === undefined) return "refresh";
  if (saved === current) return "refresh";
  return disk === saved ? "keep" : "refresh";
}
