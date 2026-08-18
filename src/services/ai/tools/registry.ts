/**
 * 工具注册表：把自包含 `ToolDefinition` 列表组织成「名册 → 模型」「参数 → 执行」的按名分发器。
 * 取代旧的 `stores/toolRunner.ts` 的 switch：加工具 = 加一个 defineTool 模块 + 注册进列表，不再改分发逻辑。
 */
import type {
  ToolDefinition,
  ToolExecContext,
  ToolExecResult,
  ToolResult,
  ToolSchema,
  LlmMessage,
  LlmToolCall,
} from "@/types";
import { UNKNOWN_TOOL_MSG_PREFIX } from "@/types";
import { toToolSchema } from "./defineTool";

/** 一次执行结束后的回填工具消息 + 可视化结果 + 原始结果（供调用方 hooks 消费 data 建产物）。 */
export interface ToolDispatchResult {
  messages: LlmMessage[];
  results: ToolExecResult[];
  /** 已成功执行（未被中止跳过）的原始结果，含 data（画布据此建产物节点）。 */
  outcomes: Array<{ name: string; id: string; result: ToolResult }>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析工具调用参数 JSON（非法抛 ToolArgsError，由 validate 决定更具体语义）。 */
function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("参数不是合法 JSON");
  }
}

export interface ToolRegistry {
  /** 按名取定义（无则 undefined）。 */
  get(name: string): ToolDefinition | undefined;
  /** 全部名册（发给模型）。 */
  toSchemas(): ToolSchema[];
  /** 运行前摘要（气泡工具块展示，容忍残缺参数）。 */
  summarize(name: string, argsJson: string): string;
  /** 执行一轮工具调用（依次执行，中止后跳过回填）。 */
  dispatch(calls: LlmToolCall[], exec: ToolExecContext): Promise<ToolDispatchResult>;
}

/** 由一组工具定义构建按名分发注册表。 */
export function createToolRegistry(defs: ToolDefinition[]): ToolRegistry {
  const byName = new Map(defs.map((d) => [d.name, d]));

  const get = (name: string): ToolDefinition | undefined => byName.get(name);

  const toSchemas = (): ToolSchema[] => defs.map(toToolSchema);

  const summarize = (name: string, argsJson: string): string => {
    const def = byName.get(name);
    if (!def) return name;
    let args: unknown;
    try {
      args = def.validate(parseArgs(argsJson));
    } catch {
      // 残缺参数：降级为工具的通用摘要（工具块仍可见调用事实）
      args = {};
    }
    return def.summarize(args as Record<string, unknown>);
  };

  const dispatch = async (
    calls: LlmToolCall[],
    exec: ToolExecContext,
  ): Promise<ToolDispatchResult> => {
    const messages: LlmMessage[] = [];
    const results: ToolExecResult[] = [];
    const outcomes: ToolDispatchResult["outcomes"] = [];
    for (const call of calls) {
      const def = byName.get(call.name);
      if (!def) {
        const msg = `${UNKNOWN_TOOL_MSG_PREFIX}${call.name}`;
        messages.push({ role: "tool", text: msg, toolCallId: call.id });
        results.push({ id: call.id, ok: false, summary: msg, detail: msg });
        continue;
      }
      // 参数校验（失败给错误 tool 消息，不执行）
      let args: unknown;
      try {
        args = def.validate(parseArgs(call.arguments));
      } catch (e) {
        const msg = `工具参数错误：${errorText(e)}`;
        messages.push({ role: "tool", text: msg, toolCallId: call.id });
        results.push({ id: call.id, ok: false, summary: msg, detail: msg });
        continue;
      }
      // 执行（边界捕获：执行器异常降级为失败结果，不抛断整轮）
      let result: ToolResult;
      try {
        result = await def.execute(args as Record<string, unknown>, exec);
      } catch (e) {
        result = { ok: false, summary: errorText(e) };
      }
      // 用户已中止：副作用可能已发生，但结果不回填（引擎下一轮携已 abort 的 signal 收敛）
      if (exec.signal.aborted) continue;
      messages.push({
        role: "tool",
        text: (def.renderResult ?? ((r) => r.content ?? r.summary))(result),
        toolCallId: call.id,
      });
      results.push({
        id: call.id,
        ok: result.ok,
        summary: result.summary,
        detail: result.content ?? result.summary,
      });
      outcomes.push({ name: call.name, id: call.id, result });
    }
    return { messages, results, outcomes };
  };

  return { get, toSchemas, summarize, dispatch };
}
