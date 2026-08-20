/**
 * Agent 预置常量：默认随每个仓库出现的两个不可删除 Agent（builtin 标记）。
 *
 * - 「对话」：除「写入/编辑文件」外的全部工具（只读 + 检索 + 联网；缺省对话可查可搜，
 *   但不会产生任何文件改动）
 * - 「Agent」：拥有全部工具（AGENT_TOOLS_META 全集）
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

/** 预置「对话」Agent 工具集：AGENT_TOOLS_META 全集剔除 write_file/edit_file（只读 + 检索 + 联网）。 */
export const BUILTIN_CHAT_TOOLS: string[] = AGENT_TOOLS_META.filter(
  (t) => t.id !== "write_file" && t.id !== "edit_file",
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
