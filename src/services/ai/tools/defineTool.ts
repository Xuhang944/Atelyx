/**
 * `defineTool`：自包含工具模块的构建器。
 *
 * 一个工具 = schema + 参数校验(validate) + 摘要(summarize) + 执行(execute，走注入 capabilities) + 结果回填(renderResult)，
 * 全部在一个文件里。必填字段由 `ToolDefinition` 类型静态保障（strict 下缺字段编译不过），
 * 这里只负责补 `renderResult` 缺省回填。
 */
import type { ToolDefinition } from "@/types";

/** 补齐缺省 renderResult（工具未自定义回填时按 `content ?? summary` 回填模型）。 */
export function defineTool<A = Record<string, unknown>>(
  def: ToolDefinition<A>,
): ToolDefinition<A> {
  return {
    ...def,
    renderResult: def.renderResult ?? ((r) => r.content ?? r.summary),
  };
}
