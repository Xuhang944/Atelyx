/**
 * 工具：读取文件（read_file）。读取仓库内任意文本文件的全文，回填上下文，供回答/后续修改依据。
 * 依赖 `capabilities.readFile`。只读，不建产物节点。
 */
import { ToolArgsError } from "@/types";
import { AGENT_TOOLS_META } from "@/constants/tools";
import { defineTool } from "./defineTool";

const meta = AGENT_TOOLS_META.find((m) => m.id === "read_file")!;

export interface ReadFileArgs {
  path: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const READ_FILE_TOOL = defineTool<ReadFileArgs>({
  name: "read_file",
  label: meta.label,
  description:
    "读取仓库中指定文件的全文内容（文本文件，相对仓库根路径），作为回答或后续修改的依据",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件相对仓库根的路径，如「产品需求.md」或「笔记/方案.txt」" },
    },
    required: ["path"],
  },
  validate: (args) => {
    const p = (args as { path?: unknown } | undefined)?.path;
    if (typeof p !== "string" || !p.trim()) throw new ToolArgsError("缺少文件路径 path");
    return { path: p };
  },
  summarize: (args) => {
    const p = args.path?.trim();
    return p ? `读取 ${p.slice(0, 48)}` : "读取文件";
  },
  execute: async (args, exec) => {
    const cap = exec.capabilities.readFile;
    if (!cap) return { ok: false, summary: "读取文件能力未启用" };
    try {
      const content = await cap(args.path);
      return { ok: true, summary: `已读取「${args.path}」`, content };
    } catch (e) {
      return { ok: false, summary: `读取失败：${errText(e)}` };
    }
  },
});
