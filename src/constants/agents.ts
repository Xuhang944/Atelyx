/**
 * Agent 预置常量：默认随每个仓库出现的两个不可删除 Agent（builtin 标记）。
 *
 * - 「对话」：只读基础工具（read_file/glob/grep 恒可用）+ 联网搜索/抓取网页，无写入/编辑
 * - 「Agent」：全部可配置工具（联网搜索/抓取/编辑/写入 + 只读基础工具）
 *
 * 预置 Agent 可编辑（改名/改工具/配提示词）但不可删除；settingsStore 加载时
 * 缺失即补入并落盘（首次种子 / 手删补齐），保证默认必现。
 */
import type { AgentConfig } from "@/types";
import { AGENT_TOOLS_META, DEFAULT_AGENT_TOOLS } from "@/constants/tools";

/** 预置「对话」Agent 固定 id（不可删除）。 */
export const BUILTIN_AGENT_CHAT_ID = "builtin-chat";
/** 预置「Agent」Agent 固定 id（不可删除）。 */
export const BUILTIN_AGENT_AGENT_ID = "builtin-agent";

/** 预置「对话」Agent 工具集：只读基础工具恒可用，此处仅登记可勾选的「联网搜索 + 抓取网页」（缺省自带）。 */
export const BUILTIN_CHAT_TOOLS: string[] = AGENT_TOOLS_META.filter(
  (t) => !t.readOnly && t.id !== "write_file" && t.id !== "edit_file",
).map((t) => t.id);

/** 预置 Agent 列表（顺序 = 列表/下拉展示顺序，恒置顶）。 */
export const BUILTIN_AGENTS: AgentConfig[] = [
  { id: BUILTIN_AGENT_CHAT_ID, name: "对话", tools: [...BUILTIN_CHAT_TOOLS], builtin: true },
  {
    id: BUILTIN_AGENT_AGENT_ID,
    name: "Agent",
    tools: [...DEFAULT_AGENT_TOOLS],
    builtin: true,
  },
];
