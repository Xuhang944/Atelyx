/** OpenAI 兼容 function 定义（AI 对话工具，如联网搜索）。 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
