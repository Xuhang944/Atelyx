/**
 * `defineTool`：自包含工具模块的构建器。
 *
 * 一个工具 = schema + 参数校验(validate) + 摘要(summarize) + 执行(execute，走注入 capabilities) + 结果回填(renderResult)，
 * 全部在一个文件里。构建期做轻校验，缺核心字段直接抛错（早失败，不等到运行时才暴露）。
 */
import type { ToolDefinition, ToolSchema } from "@/types";

/** 构建期缺字段等错误的固定抛错（区别于 ToolArgsError 的参数错误）。 */
class defineToolError extends Error {}

/** 校验工具定义必填字段，返回带缺省 renderResult 的完整定义。 */
export function defineTool<A = Record<string, unknown>>(
  def: ToolDefinition<A>,
): ToolDefinition<A> {
  if (!def.name || !def.description || !def.parameters) {
    throw new defineToolError(`defineTool(${def.name ?? "<未命名>"}): 缺 name/description/parameters`);
  }
  if (typeof def.validate !== "function") {
    throw new defineToolError(`defineTool(${def.name}): 缺 validate`);
  }
  if (typeof def.summarize !== "function") {
    throw new defineToolError(`defineTool(${def.name}): 缺 summarize`);
  }
  if (typeof def.execute !== "function") {
    throw new defineToolError(`defineTool(${def.name}): 缺 execute`);
  }
  return {
    ...def,
    renderResult: def.renderResult ?? ((r) => r.content ?? r.summary),
  };
}

/** 工具定义 → 发给模型的中性名册条目。 */
export function toToolSchema(def: ToolDefinition): ToolSchema {
  return { name: def.name, description: def.description, parameters: def.parameters };
}
