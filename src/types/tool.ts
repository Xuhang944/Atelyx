/**
 * AI 工具契约。
 *
 * - `ToolSchema`：发给模型的工具名册描述（中性，适配器转供应商 tools 字段）。
 * - `ToolDefinition`：自包含工具模块的完整定义。schema/参数校验/摘要/执行/结果回填
 *   全部收敛在一个文件里，新增工具 = 一个 defineTool 模块 + 注册，不再改 switch。
 * - `ToolExecContext`：执行上下文，能力经 `capabilities` 注入（运行时由调用方注入），
 *   工具本身不直接 import store —— 保证可移植、可复用。
 */
import type { SearchResultData } from "./node";

/** 发给模型的工具名册描述（对应 OpenAI function 定义）。 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema（arguments）。 */
  parameters: Record<string, unknown>;
}

/** 一次工具执行结果（可视化 + 回填模型用）。 */
export interface ToolResult {
  ok: boolean;
  /** 气泡工具块展示的短摘要。 */
  summary: string;
  /** 要回填给模型的文本（缺省由 ToolDefinition.renderResult 决定）。 */
  content?: string;
  /** 供调用方 hooks 消费的产物数据（如画布建节点）。 */
  data?: unknown;
}

/** 工具执行所需的能力缝（由调用方注入；工具依赖此而非 store）。 */
export interface ToolCapabilities {
  /** 联网搜索（依赖搜索源配置）。 */
  search?: (query: string) => Promise<SearchResultData>;
  /** 读仓库内任意文本文件，返回正文。 */
  readFile?: (path: string) => Promise<string>;
  /** 写仓库内任意文本文件（指定相对路径，直接落盘）。 */
  writeFile?: (path: string, content: string) => Promise<{ ok: boolean; summary: string }>;
  /** 行级修改仓库内任意文本文件（oldText 唯一匹配）。 */
  editFile?: (
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
  ) => Promise<{ ok: boolean; summary: string }>;
  /** 抓取网页正文。 */
  fetchUrl?: (url: string) => Promise<{ url: string; title?: string; content: string }>;
}

/** 工具执行上下文（signal 中止 + 注入的能力）。 */
export interface ToolExecContext {
  signal: AbortSignal;
  capabilities: ToolCapabilities;
}

/** 自包含工具模块（defineTool 产出）。 */
export interface ToolDefinition<A = Record<string, unknown>> {
  /** 工具名（发给模型，也是注册表/UI 的联结 id）。 */
  name: string;
  /** UI 设置浮层显示名。 */
  label: string;
  description: string;
  /** 发给模型的 JSON Schema。 */
  parameters: Record<string, unknown>;
  /** 参数解析 + 校验（非法抛 `ToolArgsError`），返回强类型参数。 */
  validate: (args: unknown) => A;
  /** 气泡摘要。 */
  summarize: (args: A) => string;
  /** 执行（走注入的 capabilities）。 */
  execute: (args: A, exec: ToolExecContext) => Promise<ToolResult>;
  /** 回填模型的 tool 消息文本，缺省 = `result.content ?? result.summary`。 */
  renderResult?: (result: ToolResult) => string;
}

/** 工具注册表中「未知工具」的错误消息文本。 */
export const UNKNOWN_TOOL_MSG_PREFIX = "未知工具：";

/** 工具模块构建期/参数校验失败。 */
export class ToolArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgsError";
  }
}

/** 单个工具执行结果的可视化摘要（消息气泡工具块）。 */
export interface ToolExecResult {
  id: string;
  ok: boolean;
  summary: string;
}
