/**
 * AI 工具（Agent 模式）UI 元数据 + 默认勾选。
 *
 * 这里只放**组件可见**的展示元数据（id/label/依赖项），工具的可执行定义（schema/参数校验/
 * 摘要/执行/回填）在 `services/ai/tools/*`。两者以 `id`（= 工具名）为联结键；label 单一来源于此，
 * 工具模块按 id 引用。`.atlx`/内存态只存 `agentTools: string[]`（id 列表）。
 *
 * 工具为基础文件/网络能力（对仓库内任意文本文件与网页生效），命名通用规范。
 */
export interface AgentToolMeta {
  id: string;
  label: string;
  /** 依赖搜索源配置（未配置时自动剔除并提示）。 */
  needsSearch?: boolean;
}

/** UI 展示与默认勾选的工具名单（执行层同名集合见 services/ai/tools）。 */
export const AGENT_TOOLS_META: AgentToolMeta[] = [
  { id: "web_search", label: "联网搜索", needsSearch: true },
  { id: "web_fetch", label: "抓取网页" },
  { id: "read_file", label: "读取文件" },
  { id: "edit_file", label: "编辑文件" },
  { id: "write_file", label: "写入文件" },
];

/** Agent 模式默认启用的工具 id 全集（缺省 = 全部工具，用户按需关闭个别）。 */
export const DEFAULT_AGENT_TOOLS = AGENT_TOOLS_META.map((t) => t.id);
