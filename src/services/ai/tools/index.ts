/**
 * AI 工具（Agent 模式）执行层入口。
 *
 * - `AGENT_TOOLS`：注册表（自包含工具 + 按名分发），取代旧工具的 switch 分发。
 * - `buildAgentTools`：按勾选 id + 搜索是否已配置，组装发给模型的 `ToolSchema[]`。
 * - `runAgentTools`：执行一轮工具（差异由调用方 hooks 消化，如画布建产物节点）。
 * 工具只经注入的 `ToolCapabilities` 访问仓库/搜索能力，不 import store —— 可移植、可复用。
 */
import type {
  LlmMessage,
  LlmToolCall,
  ToolDefinition,
  ToolExecContext,
  ToolExecResult,
  ToolResult,
  ToolSchema,
} from "@/types";
import { WEB_SEARCH_TOOL } from "./webSearch";
import { WEB_FETCH_TOOL } from "./webFetch";
import { READ_FILE_TOOL } from "./readFile";
import { EDIT_FILE_TOOL } from "./editFile";
import { WRITE_FILE_TOOL } from "./writeFile";
import { createToolRegistry } from "./registry";

/** Agent 模式全部工具（注册顺序 = 名册/浮层展示顺序）。各工具参数类型各异，注册为通用定义。 */
export const AGENT_TOOLS = [
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  READ_FILE_TOOL,
  EDIT_FILE_TOOL,
  WRITE_FILE_TOOL,
] as unknown as ToolDefinition[];

const registry = createToolRegistry(AGENT_TOOLS);

/** 运行前摘要（消息气泡工具块展示，容忍残缺参数）。 */
export function summarizeAgentTool(name: string, argsJson: string): string {
  return registry.summarize(name, argsJson);
}

/** 组装结果：发给模型的工具名册 + 本次剔除提示。 */
export interface AgentToolAssembly {
  tools: ToolSchema[];
  /** web_search 被勾选但搜索源未配置（调用方据此提示）。 */
  skippedWebSearch: boolean;
  /** 勾选里已不存在的工具 id（存量数据兼容，静默忽略不崩）。 */
  unknownIds: string[];
}

/** 按勾选 id + 搜索配置组装工具名册；未知 id 静默忽略（不迁移存量数据）。 */
export function buildAgentTools(
  enabledIds: string[],
  searchReady: boolean,
): AgentToolAssembly {
  const tools: ToolSchema[] = [];
  let skippedWebSearch = false;
  const known = new Set(AGENT_TOOLS.map((t) => t.name));
  const unknownIds = enabledIds.filter((id) => !known.has(id));
  for (const def of AGENT_TOOLS) {
    if (!enabledIds.includes(def.name)) continue;
    if (def.name === "web_search" && !searchReady) {
      skippedWebSearch = true;
      continue;
    }
    tools.push({ name: def.name, description: def.description, parameters: def.parameters });
  }
  return { tools, skippedWebSearch, unknownIds };
}

/** 工具产物 hooks（画布建节点 vs 面板不建 的差异收敛于此）。 */
export interface AgentToolHooks {
  /** 工具成功产物回调（data 为具体 payload：write_file → {path}）。 */
  onToolResult?: (name: string, result: ToolResult) => void;
}

/** 执行一轮工具调用（公共执行器，画布/面板共用）。 */
export async function runAgentTools(
  calls: LlmToolCall[],
  exec: ToolExecContext,
  hooks?: AgentToolHooks,
): Promise<{ messages: LlmMessage[]; results: ToolExecResult[] }> {
  const { messages, results, outcomes } = await registry.dispatch(calls, exec);
  if (hooks?.onToolResult) {
    for (const o of outcomes) {
      try {
        hooks.onToolResult(o.name, o.result);
      } catch {
        // 产物节点创建失败只跳过该产物，不回断整轮结果回填（否则 done 不回调、工具行永久转圈）
      }
    }
  }
  return { messages, results };
}
