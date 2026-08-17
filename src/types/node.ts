import type { Edge, Node } from "@xyflow/react";

/** 单条搜索结果（AI 自主搜索产物）。 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** 搜索结果节点 data（结构嵌 .atlx，不单独文件化；4.6）。 */
export interface SearchResultData {
  /** 搜索词（节点标题） */
  query: string;
  results: SearchResultItem[];
  /** 搜索失败时错误信息（节点显示错误 + 重试，4.6 失败降级） */
  error?: string;
  /** 勾选的条目下标（「仅将勾选条目注入上下文」；缺省 = 全部注入） */
  checked?: number[];
}

/**
 * 节点类型枚举（运行时；与磁盘格式 CanvasFileNode.type 对应，见 types/canvas.ts）。
 */
export type NodeKind = "conversation" | "text" | "media" | "search";

/**
 * 各节点类型的专属 data 结构。
 * data 由各节点组件消费；DB 层以 JSON 字符串存于 nodes.data 列。
 */
export interface ConversationData {
  providerId: string;
  model: string;
  /** 系统提示词笔记（相对仓库根 `.md` 路径，如 `笔记/提示词.md`）。发送时实时读正文注入 system 消息，外部编辑即时生效。 */
  systemPromptFile?: string;
  /** LLM 自动生成的话题标题（首轮对话完成后命名，InspectorPanel 来源/血缘显示名用；缺省 = 未命名）。 */
  title?: string;
  /** 启用 AI Agent 模式（缺省关 = 普通对话，不带任何工具）：开启后 AI 可自主调用工具（见 agentTools）。 */
  agentMode?: boolean;
  /** Agent 模式启用的工具名列表（constants/tools.ts 的 AGENT_TOOLS_META id；缺省 = 全部工具）。 */
  agentTools?: string[];
}

export interface TextData {
  /** 标题（显示用） */
  title: string;
  /**
   * 相对仓库根的 `.md` 路径，如 `笔记/提示词.md`。
   * - 有 file = 笔记节点：正文存独立 `.md`（外部可编辑、可跨画布共享），bodyMd 运行时从文件填充、持久化时剥离
   * - 无 file = 画布内文本节点：仅存在于画布，bodyMd 随 `.atlx` 内嵌保存；右键「保存为笔记」后生成 `.md` 转为笔记节点
   */
  file?: string;
  /**
   * 正文。
   * - 笔记节点：运行时从 `.md` 填充，持久化时写回 `.md` 并剥离
   * - 画布内文本节点：随 `.atlx` 内嵌持久化（唯一存储）
   */
  bodyMd?: string;
  /** 引用文件被外部删除/重命名时降级标记（仅笔记节点，运行时态不持久化） */
  fileMissing?: boolean;
}

export interface MediaData {
  /** 相对仓库根的附件路径，如 `附件/image-xxx.png`（原 filePath，仓库化改名） */
  file?: string;
  mime: string;
  kind: "image" | "file";
  /** 图片：dataURL 预览（运行时缓存；TODO 后续落盘 `附件/` 改存路径，剥离 thumb） */
  thumb?: string;
  /** 文件名（画布显示用） */
  name?: string;
  /** 二进制类解析失败时标注，仅作画布参考、不注入模型 */
  parseFailed?: boolean;
  /** 文本类文件解析出的内容（@ 引用/连边时注入用） */
  body?: string;
  /**
   * 按图片真实比例计算的展示宽度（px），首次加载时推导并持久化。
   * 用户 resize 后此字段不再生效。
   */
  displayWidth?: number;
  /** 用户是否手动 resize 过此节点，用于区分 auto 高度与固定高度两种渲染分支。 */
  userResized?: boolean;
  /** 引用文件被外部删除/重命名时降级标记（对称 TextData.fileMissing，运行时态不持久化） */
  fileMissing?: boolean;
}

export interface TableData {
  /** 相对仓库根的 .atb 路径（表格节点 = 仓库表格文件引用，如 `项目A/分镜.atb`） */
  file: string;
  title: string;
  /**
   * 表格内容快照文本（运行时从 .atb 填充/外部修改刷新，注入对话上下文用；持久化时剥离——
   * 与笔记节点 bodyMd 同模式，内容在独立文件）。
   */
  snapshot?: string;
  /** 引用文件被外部删除/重命名时降级标记（运行时态不持久化） */
  fileMissing?: boolean;
}

/**
 * 统一的节点 data 联合类型，配合 React Flow 的 Node<T> 泛型使用。
 * 各子类型与 Record<string, unknown> 交叉满足 React Flow 约束，
 * 类型窄化时仍能获得具体属性。
 */
export type CanvasNodeData =
  | (ConversationData & Record<string, unknown>)
  | (TextData & Record<string, unknown>)
  | (MediaData & Record<string, unknown>)
  | (SearchResultData & Record<string, unknown>)
  | (TableData & Record<string, unknown>);

export type CanvasNode = Node<CanvasNodeData>;

/** 关联边（directed: false）的箭头模式：无向 / 单向 / 双向。缺省 = 无向。 */
export type LinkMode = "none" | "single" | "double";

/**
 * 运行时边（React Flow Edge + 画布扩展字段）。
 * `directed: false` = 关联自由线（无消费语义、可删除、箭头模式由 linkMode 决定）；
 * 缺省（undefined）= 数据流边（金色箭头，引用/产出/血缘语义）。
 */
export type CanvasEdge = Edge & { directed?: boolean; linkMode?: LinkMode };
