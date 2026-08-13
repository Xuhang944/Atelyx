/**
 * AI 对话工具定义（OpenAI 兼容 function calling）。
 * 画布对话节点与 AI 对话面板共用；发送前由调用方按 Agent 模式 + agentTools 勾选决定是否携带。
 */
import type { ToolDef } from "@/types";

/** 联网搜索工具：AI 自主决定搜索，结果回填上下文。 */
export const WEB_SEARCH_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网搜索获取最新信息，返回网页标题、摘要与链接（可作为回答依据）",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
  },
};

/** 写笔记工具：AI 自主把产物沉淀为仓库 .md 笔记（画布场景同时生成笔记节点）。 */
export const WRITE_NOTE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "write_note",
    description:
      "把内容写入一篇仓库笔记（Markdown 文件）：生成可复用、可编辑的笔记，返回生成的笔记文件名",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题（将作为文件名，勿含 / 等特殊字符）" },
        content: { type: "string", description: "笔记正文，Markdown 格式" },
      },
      required: ["title", "content"],
    },
  },
};

/** 填表格行工具：AI 自主向指定表格追加数据行（键 = 字段名，值 = 字段值）。 */
export const APPEND_TABLE_ROW_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "append_table_row",
    description:
      "向指定多维表格追加数据行：rows 为对象数组，每项键 = 表格字段名、值 = 字段值（数字字段传数字，其余传字符串），返回追加结果",
    parameters: {
      type: "object",
      properties: {
        tableTitle: { type: "string", description: "目标表格标题（表格文件名，不含 .atb 扩展名）" },
        rows: {
          type: "array",
          items: { type: "object", description: "一行数据：键 = 字段名、值 = 字段值" },
          description: "要追加的行数据",
        },
      },
      required: ["tableTitle", "rows"],
    },
  },
};

/** 修改笔记工具：AI 行级修改 .md 原文（oldText 精确且唯一匹配，全部校验通过后统一替换）。 */
export const EDIT_NOTE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "edit_note",
    description:
      "修改仓库笔记（.md 文件）的指定文本：edits 每项 oldText 必须与笔记现有文本精确匹配且唯一（不唯一请扩充上下文），全部匹配后统一替换，返回修改结果",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "目标笔记（文件名或相对路径，如「产品需求」或「笔记/产品需求.md」）" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "要替换的原文（必须与笔记中现有文本精确匹配且唯一）" },
              newText: { type: "string", description: "替换后的新文本" },
            },
            required: ["oldText", "newText"],
          },
          description: "替换列表（各块在原文上匹配，块间不得重叠）",
        },
      },
      required: ["note", "edits"],
    },
  },
};

/** Agent 模式工具注册表：id = 工具名（.atlx/内存态只存 id 列表），label = 设置浮层显示名。 */
export interface AgentToolMeta {
  id: string;
  label: string;
  def: ToolDef;
}

export const AGENT_TOOLS: AgentToolMeta[] = [
  { id: "web_search", label: "联网搜索", def: WEB_SEARCH_TOOL },
  { id: "write_note", label: "写笔记", def: WRITE_NOTE_TOOL },
  { id: "append_table_row", label: "填表格", def: APPEND_TABLE_ROW_TOOL },
  { id: "edit_note", label: "修改笔记", def: EDIT_NOTE_TOOL },
];

/** Agent 模式默认启用的工具 id 全集（缺省 = 全部工具，用户按需关闭个别）。 */
export const DEFAULT_AGENT_TOOLS = AGENT_TOOLS.map((t) => t.id);

/** 工具参数摘要（消息气泡工具块展示用）：从 arguments JSON 提取人话摘要，解析失败降级为通用文案。 */
export function summarizeToolArgs(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    // 参数残缺：降级为通用文案（工具块仍可见调用事实）
  }
  switch (name) {
    case "web_search": {
      const q = typeof args.query === "string" ? args.query.trim() : "";
      return q ? `搜索「${q.slice(0, 40)}」` : "联网搜索";
    }
    case "write_note": {
      const t = typeof args.title === "string" ? args.title.trim() : "";
      return t ? `写笔记《${t.slice(0, 40)}》` : "写笔记";
    }
    case "append_table_row": {
      const t = typeof args.tableTitle === "string" ? args.tableTitle.trim() : "";
      const n = Array.isArray(args.rows) ? args.rows.length : 0;
      return t ? `向「${t.slice(0, 40)}」追加 ${n} 行` : `追加 ${n} 行`;
    }
    case "edit_note": {
      const t = typeof args.note === "string" ? args.note.trim() : "";
      const n = Array.isArray(args.edits) ? args.edits.length : 0;
      return t ? `修改《${t.slice(0, 40)}》${n} 处` : `修改笔记 ${n} 处`;
    }
    default:
      return name;
  }
}
