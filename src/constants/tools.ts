/**
 * AI 工具（Agent 模式）UI 元数据 + 默认勾选 + read_file 分页执行常量。
 *
 * 这里放**组件可见**的展示元数据（id/label/依赖项）与 read_file 分页默认行数（工具/服务共用）；
 * 工具的可执行定义（schema/参数校验/摘要/执行/回填）在 `services/ai/tools/*`。两者以 `id`
 * （= 工具名）为联结键。Agent 配置里勾选的工具以 id 列表存 `.atelyx/agents.json`。
 *
 * 工具为基础文件/网络能力（对仓库内任意文本文件与网页生效），命名通用规范。
 */
export interface AgentToolMeta {
  id: string;
  label: string;
  /** 依赖搜索源配置（未配置时自动剔除并提示）。 */
  needsSearch?: boolean;
  /** 只读基础工具：默认恒可用，不依赖 Agent 勾选（设置页不显示开关）。 */
  readOnly?: boolean;
}

/** read_file 单次默认/最大返回行数（分页读取，模型可传 offset 继续读大文件）。
 * 单行字符/单次字节预算上限由 Rust 侧 `read_vault_file_window` 强制（见 commands/vault.rs），
 * 前端无需重复定义。 */
export const READ_WINDOW_DEFAULT_LINES = 2000;

/** glob 单次内联返回路径上限 / grep 单次内联返回匹配上限 / grep 单行预览字节上限。
 * 均由 Rust 侧 filesearch.rs 强制（glob_vault/grep_vault），此处仅用于工具描述文案，
 * 口径与 READ_WINDOW_DEFAULT_LINES 一致。 */
export const GLOB_MAX_RESULTS = 100;
export const GREP_MAX_MATCHES = 250;
export const GREP_MAX_LINE_BYTES = 2000;

/** 单轮内并行安全的工具调用最大在飞数（有界滚动池；1 = 全串行）。 */
export const MAX_PARALLEL_TOOL_CALLS = 10;

/** UI 展示与默认勾选的工具名单（执行层同名集合见 services/ai/tools）。 */
export const AGENT_TOOLS_META: AgentToolMeta[] = [
  { id: "web_search", label: "联网搜索", needsSearch: true },
  { id: "web_fetch", label: "抓取网页" },
  { id: "read_file", label: "读取文件", readOnly: true },
  { id: "glob", label: "查找文件", readOnly: true },
  { id: "grep", label: "搜索内容", readOnly: true },
  { id: "edit_file", label: "编辑文件" },
  { id: "write_file", label: "写入文件" },
];

/** 只读基础工具 id 集合：组装工具名册时无条件并入（不依赖 Agent 勾选）。 */
export const READONLY_TOOL_IDS = AGENT_TOOLS_META.filter((t) => t.readOnly).map((t) => t.id);

/** Agent 模式默认启用的可配置工具 id（只读基础工具恒可用，不在此列）。 */
export const DEFAULT_AGENT_TOOLS = AGENT_TOOLS_META.filter((t) => !t.readOnly).map((t) => t.id);

/**
 * 系统提示词引导（工具含 read_file 时追加，随每条请求进 system 消息）：
 * @引用 的笔记只带文件路径，模型需用 read_file 按路径读取正文，而不是猜测内容；
 * 目录引用（/ 结尾）先 glob 列内容再按需读取。
 */
export const FILE_REFERENCE_PROMPT =
  "以 @ 前缀引用的文件是用户明确指定的笔记，其相对仓库根路径列在消息开头「引用文件」列表中。需要其内容时用 read_file 工具读取；在读取之前不要声称已查看过该文件。以 / 结尾的引用是目录：先用 glob 工具（path 参数指向该目录）列出其中的文件，再按需 read_file。";
