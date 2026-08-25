/**
 * Agent 步进（`Message.steps`）的纯数据操作：画布与面板共用。
 *
 * 归一化 - `steps` 为展示的权威来源（思考步与工具步按序交错）；
 * 旧 `.atlx` 消息只有 `reasoningContent`+`toolRuns` 遗留字段，经 `normalizeAgentSteps`
 * 推导为「单思考步 + 工具步」。新写入一律只写 `steps`。
 *
 * 思考流式累积（`appendReasoning`）与工具轮合并（`mergeToolRuns`）都是不可变更新——
 * 思考/叙述并入「当前轮」最后一个同类型步（尾部向前找，遇工具步即停），
 * 这样思考与叙述交错到达（同一 rAF 帧 flush）时不会把一段思考拆成两个思考块；
 * 工具轮之间的思考仍自然分隔（第二轮思考不会并进第一轮）。
 */
import type { AgentStep, Role, ToolRun } from "@/types";

/**
 * 思考增量写入 steps：并入当前轮最后一个思考步（尾部向前找第一个 reasoning，遇工具步即停）。
 * 只当最后一步是思考步才拼接会漏掉「思考/叙述同帧到达」的情况——叙述步插在中间后，
 * 后续思考增量会被拆成新思考步（一段思考渲染成两个折叠块）。工具轮之间依旧分隔。
 */
export function appendReasoning(steps: AgentStep[], text: string): AgentStep[] {
  if (!text) return steps;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "reasoning") {
      return [
        ...steps.slice(0, i),
        { kind: "reasoning", text: s.text + text },
        ...steps.slice(i + 1),
      ];
    }
    if (s.kind === "tool") break;
  }
  return [...steps, { kind: "reasoning", text }];
}

/** 叙述正文增量写入 steps（工具轮的文本叙述，渲染为该步的「叙述行」）：并入当前轮最后一个 text 步（尾部向前找，遇工具步即停），否则新起。 */
export function appendNarration(steps: AgentStep[], text: string): AgentStep[] {
  if (!text) return steps;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "text") {
      return [
        ...steps.slice(0, i),
        { kind: "text", text: s.text + text },
        ...steps.slice(i + 1),
      ];
    }
    if (s.kind === "tool") break;
  }
  return [...steps, { kind: "text", text }];
}

/**
 * assistant 可回复正文：content 非空直接返回；否则回退到所有 text 叙述步拼接——
 * 叙述不再提升进 content 后，叙述-only 消息（工具可用轮直接回答、未调工具）的
 * 复制/API 历史/分支门控均以此为正文兜底。
 */
export function assistantReplyText(msg: {
  content: string;
  steps?: AgentStep[];
}): string {
  if (msg.content) return msg.content;
  return (msg.steps ?? [])
    .filter((s): s is Extract<AgentStep, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
}

/**
 * assistant 消息 content 为空时以叙述步拼接回填（叙述-only 消息的正文在 steps）：
 * API 历史 / 话题命名等按 content 取正文的消费方共用，防空正文丢失；其余消息原样返回。
 */
export function fillAssistantReplyText<
  T extends { role: Role; content: string; steps?: AgentStep[] },
>(m: T): T {
  return m.role === "assistant" && !m.content
    ? { ...m, content: assistantReplyText(m) }
    : m;
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

/**
 * 归并旧数据里被拆开的同轮思考/叙述步（幂等）：按 `appendReasoning`/`appendNarration` 的
 * 同轮合并语义重放一遍，把「思考/叙述交错到达」时期落盘的 `[reasoning, text, reasoning]`
 * 这类分裂 steps 愈合为单思考块 + 单叙述行。加载旧消息时调用，新流式不会产生分裂。
 */
export function coalesceAgentSteps(steps: AgentStep[]): AgentStep[] {
  return steps.reduce<AgentStep[]>((acc, s) => {
    if (s.kind === "reasoning") return appendReasoning(acc, s.text);
    if (s.kind === "text") return appendNarration(acc, s.text);
    return [...acc, s];
  }, []);
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
