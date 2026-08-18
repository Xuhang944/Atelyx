/**
 * Agent 步进（`Message.steps`）的纯数据操作：画布与面板共用。
 *
 * 归一化 - `steps` 为展示的权威来源（思考步与工具步按序交错）；
 * 旧 `.atlx` 消息只有 `reasoningContent`+`toolRuns` 遗留字段，经 `normalizeAgentSteps`
 * 推导为「单思考步 + 工具步」。新写入一律只写 `steps`。
 *
 * 思考流式累积（`appendReasoning`）与工具轮合并（`mergeToolRuns`）都是不可变更新——
 * 只在最后一步是思考步时拼接，否则另起思考步；从而第二轮思考不会并进第一轮。
 */
import type { AgentStep, ToolRun } from "@/types";

/** 思考增量写入 steps：最后一步是思考步则拼接，否则新起思考步（工具轮之间自然分隔）。 */
export function appendReasoning(steps: AgentStep[], text: string): AgentStep[] {
  if (!text) return steps;
  const last = steps[steps.length - 1];
  if (last && last.kind === "reasoning") {
    return [...steps.slice(0, -1), { kind: "reasoning", text: last.text + text }];
  }
  return [...steps, { kind: "reasoning", text }];
}

/** 叙述正文增量写入 steps（工具轮的文本叙述，渲染为该步的「思考行」）：最后已是 text 步则拼接，否则新起。 */
export function appendNarration(steps: AgentStep[], text: string): AgentStep[] {
  if (!text) return steps;
  const last = steps[steps.length - 1];
  if (last && last.kind === "text") {
    return [...steps.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...steps, { kind: "text", text }];
}

/**
 * 把最后一段叙述提升为最终回复正文（`onNarrationFinalize`）：
 * 收束轮（无工具、只有正文）里，把刚流式生成的最后一个 text 步从 steps 移除、并入 `content`。
 */
export function promoteLastNarration(msg: {
  steps?: AgentStep[];
  content: string;
}): { steps?: AgentStep[]; content: string } {
  const steps = msg.steps;
  if (!steps?.length) return { content: msg.content, steps };
  const last = steps[steps.length - 1];
  if (last?.kind !== "text") return { content: msg.content, steps };
  return {
    steps: steps.slice(0, -1),
    content: msg.content + last.text,
  };
}

/**
 * 工具调用合并进 steps：按 `run.id` 更新已有工具步 / 追加新工具步。
 * 跨工具轮累积全量传入（引擎发全量列表），所以多轮工具全保留、状态实时刷新。
 */
export function mergeToolRuns(steps: AgentStep[], runs: ToolRun[]): AgentStep[] {
  let changed = false;
  const next = steps.map((s) => {
    if (s.kind !== "tool") return s;
    const run = runs.find((r) => r.id === s.run.id);
    if (!run || run === s.run) return s;
    changed = true;
    return { kind: "tool" as const, run };
  });
  const existingIds = new Set(
    next.filter((s): s is Extract<AgentStep, { kind: "tool" }> => s.kind === "tool").map((s) => s.run.id),
  );
  const fresh = runs.filter((r) => !existingIds.has(r.id));
  if (fresh.length === 0) return changed ? next : steps;
  return [...next, ...fresh.map((run) => ({ kind: "tool" as const, run }))];
}

/** 旧消息（无 steps）→ 推导 steps；已含 steps 则原样返回。 */
export function normalizeAgentSteps(msg: {
  steps?: AgentStep[];
  reasoningContent?: string;
  toolRuns?: ToolRun[];
}): AgentStep[] | undefined {
  if (msg.steps && msg.steps.length > 0) return msg.steps;
  if (!msg.steps && !msg.reasoningContent && !msg.toolRuns?.length) return undefined;
  const steps: AgentStep[] = [];
  if (msg.reasoningContent) steps.push({ kind: "reasoning", text: msg.reasoningContent });
  for (const run of msg.toolRuns ?? []) steps.push({ kind: "tool", run });
  return steps;
}

/** 从消息提取工具调用记录（按序；旧数据无 steps 时回退 toolRuns 字段）。持久化 `## tool` 段用。 */
export function toolRunsOf(
  msg: { steps?: AgentStep[]; toolRuns?: ToolRun[] },
): ToolRun[] {
  if (msg.steps && msg.steps.length > 0) {
    return msg.steps
      .filter((s): s is Extract<AgentStep, { kind: "tool" }> => s.kind === "tool")
      .map((s) => s.run);
  }
  return msg.toolRuns ?? [];
}

/** 一轮步骤组 = 该步的思考/叙述（按序，多为 reasoning 或 text）+ 其全部工具行（渲染分组用）。 */
export interface AgentStepGroup {
  thinkings: Array<{ kind: "reasoning" | "text"; text: string }>;
  tools: ToolRun[];
}

/**
 * 扁平 steps → 步骤组：一轮的思考/叙述与其后的工具归为一组（最终纯思考自成一组的 thinkings）。
 * 引擎按轮发出 [reasoning?][text?][tool…]，思考/叙述在工具前，此分组才能正确对应「哪步思考→哪步工具」。
 */
export function groupAgentSteps(steps: AgentStep[]): AgentStepGroup[] {
  const groups: AgentStepGroup[] = [];
  for (const step of steps) {
    if (step.kind === "reasoning" || step.kind === "text") {
      const last = groups[groups.length - 1];
      if (last && last.tools.length === 0) {
        last.thinkings = [...last.thinkings, { kind: step.kind, text: step.text }];
      } else {
        groups.push({ thinkings: [{ kind: step.kind, text: step.text }], tools: [] });
      }
    } else {
      const last = groups[groups.length - 1];
      if (last) last.tools.push(step.run);
      else groups.push({ thinkings: [], tools: [step.run] });
    }
  }
  return groups;
}
