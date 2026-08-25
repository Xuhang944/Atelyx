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

/** read_file 分页窗口的一行（number = 文件内 1-based 绝对行号）。 */
export interface ReadWindowLine {
  number: number;
  text: string;
}

/** read_file 分页窗口结果（对应 Rust `read_vault_file_window`，camelCase 序列化）。 */
export interface ReadWindowResult {
  lines: ReadWindowLine[];
  /** 文件精确总行数（页脚引导用，即便窗口未读全）。 */
  totalLines: number;
  /** 单次返回是否命中字节预算被截断（模型应继续分页/缩小窗口）。 */
  truncated: boolean;
}

/** glob 检索结果（对应 Rust `glob_vault`，camelCase 序列化）。 */
export interface GlobVaultResult {
  /** 搜索基准：path 参数原样（缺省 = 空串 = 仓库根）。 */
  root: string;
  /** 命中的文件路径（相对仓库根、`/` 分隔；按修改时间升序，最多内联上限条）。 */
  paths: string[];
  /** 全部命中数（可能大于 paths.length，超上限时用于提示收窄）。 */
  total: number;
  /** 是否因超上限被截断（total > paths.length）。 */
  capped: boolean;
}

/** grep 匹配行（对应 Rust `GrepMatchRow`，camelCase 序列化）。 */
export interface GrepMatchRow {
  /** 相对仓库根路径（`/` 分隔）。 */
  path: string;
  /** 文件内 1-based 行号。 */
  lineNumber: number;
  /** 行内容（超长已按字节截断并附后缀）。 */
  line: string;
}

/** grep 检索结果（对应 Rust `grep_vault`）。 */
export interface GrepVaultResult {
  /** 内联返回的匹配行（最多上限条，行号升序、按文件连续）。 */
  matches: GrepMatchRow[];
  /** 全部匹配数（可能大于 matches.length，超上限时用于提示收窄）。 */
  total: number;
  /** 是否因超上限被截断（total > matches.length）。 */
  capped: boolean;
}

/** 工具执行所需的能力缝（由调用方注入；工具依赖此而非 store）。 */
export interface ToolCapabilities {
  /** 联网搜索（依赖搜索源配置）。 */
  search?: (query: string) => Promise<SearchResultData>;
  /** 分页读仓库内任意文本文件：返回带绝对行号的窗口（offset 1-based 默认 1；limit 默认见常量）。 */
  readFile?: (
    path: string,
    opts?: { offset?: number; limit?: number },
  ) => Promise<ReadWindowResult>;
  /** 写仓库内任意文本文件（指定相对路径，直接落盘）。 */
  writeFile?: (path: string, content: string) => Promise<{ ok: boolean; summary: string }>;
  /** 行级修改仓库内任意文本文件（oldText 唯一匹配）。 */
  editFile?: (
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
  ) => Promise<{ ok: boolean; summary: string }>;
  /** 按 glob 模式枚举仓库内文件路径（只返回文件，相对仓库根；上限内联 + total）。 */
  glob?: (
    pattern: string,
    opts?: { path?: string },
  ) => Promise<GlobVaultResult>;
  /** 正则搜索仓库内文件内容，返回匹配行（含行号与路径；上限内联 + total）。 */
  grep?: (
    pattern: string,
    opts?: { path?: string; include?: string },
  ) => Promise<GrepVaultResult>;
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
  /**
   * 是否可与同轮其他工具**并行**执行（缺省 false = 串行屏障，等前一批收敛再跑）。
   * 只读/无副作用工具（read_file/glob/grep/web_search/web_fetch）标 true；读写工具不标，防写竞态。
   */
  parallelSafe?: boolean;
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
  /** 完整结果文本（展开详情用；缺省 = summary）。 */
  detail?: string;
}
