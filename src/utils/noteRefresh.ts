/**
 * 文本节点（引用 `.md` 笔记）正文刷新的纯判定：磁盘内容变化时，决定某节点应
 * 「刷新到磁盘」还是「跳过（保留本地编辑）」。
 *
 * 背景：`refreshTextContent` 在 watcher 收到 `.md` 变化后重读磁盘。早期实现用
 * `lastWrittenMd` 基线判「自写回波跳过」，但 AI 文件写入（`writeVaultFile`）同样登记基线，
 * 造成「磁盘新于节点内存」被误判为回波而跳过刷新 → 节点保持陈旧，下次画布保存把旧正文
 * 回写覆盖 Agent 编辑。正确判据是「该节点自上次落盘（lastSavedNodes 基线）后是否改过正文」：
 * 改过 = 内存更新（保留，防「保存回波把新提交覆盖回旧值」的丢字竞态）；未改过 = 内存陈旧
 * （刷新到磁盘权威，外部/AI 写入皆适用）。
 */

export type TextNodeRefreshDecision = "consistent" | "keep" | "refresh";

/**
 * 判定单个文本节点对磁盘新内容的处理：
 * - `consistent`：节点正文已与磁盘一致，无需任何操作（与是否编辑过无关）。
 * - `keep`：节点自上次落盘后改过正文（`saved !== current`）且磁盘不同——本地编辑优先
 *   （LWW），跳过刷新，防丢字；本地编辑随后经画布保存自然落盘。
 * - `refresh`：节点未改过正文（`saved === current`）或尚未落盘（`saved === undefined`）
 *   且磁盘不同——内存陈旧，刷新到磁盘最新。
 */
export function decideTextNodeRefresh(
  current: string,
  saved: string | undefined,
  disk: string,
): TextNodeRefreshDecision {
  if (current === disk) return "consistent";
  if (saved !== undefined && saved !== current) return "keep";
  return "refresh";
}
