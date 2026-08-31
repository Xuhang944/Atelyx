/**
 * Agent 步进纯操作契约测试（utils/agentSteps）。
 *
 * 核心回归：思考与叙述增量在同一 rAF 帧交错到达（引擎 flushPending 先叙述后思考）时，
 * 同轮思考必须并入前一个思考步（一段思考渲染为单个「思考过程」折叠块）、同轮叙述必须并入
 * 前一个叙述步（不拆行）；工具轮之间的思考/叙述仍各自成步（分组渲染每轮独立）。
 * `assistantReplyText` 对叙述-only 消息以叙述步拼接作正文兜底。
 */
import { describe, expect, it } from "vitest";
import {
  appendNarration,
  appendReasoning,
  assistantReplyText,
  coalesceAgentSteps,
  fillAssistantReplyText,
  finalizeReplyText,
  groupAgentSteps,
  mergeToolRuns,
  promoteTrailingNarration,
} from "./agentSteps";
import { ERROR_PREFIX, PENDING_RUN_ID_PREFIX, TRUNCATED_TEXT } from "@/constants/chat";
import type { AgentStep, ToolRun } from "@/types";

const R = (text: string): AgentStep => ({ kind: "reasoning", text });
const T = (text: string): AgentStep => ({ kind: "text", text });
const run = (id: string, status: ToolRun["status"] = "done"): ToolRun => ({
  id,
  name: "web_search",
  argsSummary: `搜索(${id})`,
  status,
});
const tool = (id: string): AgentStep => ({ kind: "tool", run: run(id) });

describe("appendReasoning", () => {
  it("连续思考增量拼接进最后思考步", () => {
    expect(appendReasoning([R("我")], "想")).toEqual([R("我想")]);
  });

  it("空 steps 时新起思考步", () => {
    expect(appendReasoning([], "想")).toEqual([R("想")]);
  });

  it("思考步前有同轮叙述步时仍并入该轮思考步（不拆块）", () => {
    // 引擎同帧 flush：叙述先进 steps、思考尾随其后——修复前会拆成两个思考步
    expect(appendReasoning([R("我"), T("让我查一下")], "资料")).toEqual([
      R("我资料"),
      T("让我查一下"),
    ]);
  });

  it("工具步之后另起思考步（工具轮之间分隔）", () => {
    expect(appendReasoning([R("第一轮"), tool("t1")], "第二轮")).toEqual([
      R("第一轮"),
      tool("t1"),
      R("第二轮"),
    ]);
  });
});

describe("appendNarration", () => {
  it("连续叙述增量拼接进最后叙述步", () => {
    expect(appendNarration([T("先")], "再")).toEqual([T("先再")]);
  });

  it("叙述步前有同轮思考步时仍并入该轮叙述步（不拆行）", () => {
    expect(appendNarration([T("先"), R("想想")], "再")).toEqual([
      T("先再"),
      R("想想"),
    ]);
  });

  it("工具步之后另起叙述步", () => {
    expect(appendNarration([T("先"), tool("t1")], "再")).toEqual([
      T("先"),
      tool("t1"),
      T("再"),
    ]);
  });
});

describe("assistantReplyText", () => {
  it("content 非空时直接返回 content", () => {
    expect(assistantReplyText({ content: "最终回复", steps: [T("叙述")] })).toBe("最终回复");
  });

  it("content 为空时回退到所有叙述步拼接", () => {
    expect(
      assistantReplyText({
        content: "",
        steps: [R("想"), T("先查"), tool("t1"), T("再答")],
      }),
    ).toBe("先查\n再答");
  });

  it("无叙述步时返回空串（复制/门控按无回复处理）", () => {
    expect(assistantReplyText({ content: "", steps: [R("想"), tool("t1")] })).toBe("");
    expect(assistantReplyText({ content: "", steps: undefined })).toBe("");
  });
});

describe("fillAssistantReplyText", () => {
  it("assistant 空 content 以叙述拼接回填", () => {
    expect(
      fillAssistantReplyText({ role: "assistant", content: "", steps: [T("叙述"), tool("t1")] }).content,
    ).toBe("叙述");
  });

  it("非 assistant 或 content 非空时原样返回", () => {
    expect(fillAssistantReplyText({ role: "user", content: "问题" })).toEqual({
      role: "user",
      content: "问题",
    });
    expect(
      fillAssistantReplyText({ role: "assistant", content: "回复", steps: [T("叙述")] }).content,
    ).toBe("回复");
  });
});

describe("coalesceAgentSteps", () => {
  it("愈合同轮被拆开的思考/叙述（加载旧数据）", () => {
    expect(coalesceAgentSteps([R("我"), T("叙述"), R("资料")])).toEqual([
      R("我资料"),
      T("叙述"),
    ]);
  });

  it("保持工具轮分隔", () => {
    expect(coalesceAgentSteps([R("一"), tool("t1"), R("二")])).toEqual([
      R("一"),
      tool("t1"),
      R("二"),
    ]);
  });

  it("幂等：已归并的 steps 再归并不变", () => {
    const merged = coalesceAgentSteps([R("我"), T("叙述"), R("资料")]);
    expect(coalesceAgentSteps(merged)).toEqual(merged);
  });

  it("参数生成中的合成行归一为已中断（流式中途落盘的瞬时残留）", () => {
    const run: ToolRun = {
      id: `${PENDING_RUN_ID_PREFIX}1:0`,
      name: "write_file",
      argsSummary: "写入文件（生成中 88 字符）",
      status: "running",
    };
    const [step] = coalesceAgentSteps([{ kind: "tool", run }]);
    expect(step).toMatchObject({
      kind: "tool",
      run: { status: "error", resultSummary: "（已中断）" },
    });
  });

  it("终态合成行原样保留（不丢「已中断/参数未生成完整」历史文案）", () => {
    const run: ToolRun = {
      id: `${PENDING_RUN_ID_PREFIX}1:0`,
      name: "write_file",
      argsSummary: "写入文件（生成中 88 字符）",
      status: "error",
      resultSummary: "（参数未生成完整）",
    };
    expect(coalesceAgentSteps([{ kind: "tool", run }])).toEqual([{ kind: "tool", run }]);
  });
});

describe("流式同帧交错（回归：思考被拆成两行）", () => {
  it("叙述与思考同帧 flush 不产生拆分，渲染为单思考组", () => {
    // 模拟引擎 flushPending 顺序：先叙述（onNarration）后思考（applyBatch）
    let steps: AgentStep[] = [];
    const flush = (narr: string, reason: string) => {
      if (narr) steps = appendNarration(steps, narr);
      if (reason) steps = appendReasoning(steps, reason);
    };
    flush("", "我"); // 思考阶段
    flush("", "想想");
    flush("让我查", "资料"); // 思考→回答过渡帧：叙述与思考尾同时到达（修复点）
    flush("", "再想");
    expect(steps).toEqual([R("我想想资料再想"), T("让我查")]);

    const groups = groupAgentSteps(steps);
    expect(groups).toHaveLength(1); // 单组 → 渲染单个「思考过程」折叠块
    expect(groups[0].thinkings).toEqual([
      { kind: "reasoning", text: "我想想资料再想" },
      { kind: "text", text: "让我查" },
    ]);
    expect(groups[0].tools).toEqual([]);

    // 叙述以叙述行展示：叙述-only 消息以叙述步拼接作可回复正文兜底（assistantReplyText 回退）；
    // 新引擎在最终回答轮（无工具调用）经 promoteTrailingNarration 提升进 content
    expect(assistantReplyText({ steps, content: "" })).toBe("让我查");
  });
});

describe("groupAgentSteps", () => {
  it("多轮思考→工具各自成组（每轮一个思考块，设计行为不回退）", () => {
    const groups = groupAgentSteps([R("一"), T("叙述"), tool("t1"), R("二")]);
    expect(groups).toHaveLength(2);
    expect(groups[0].thinkings.map((t) => t.text)).toEqual(["一", "叙述"]);
    expect(groups[0].tools.map((r) => r.id)).toEqual(["t1"]);
    expect(groups[1].thinkings).toEqual([{ kind: "reasoning", text: "二" }]);
    expect(groups[1].tools).toEqual([]);
  });
});

describe("mergeToolRuns（参数生成中的合成行生命周期）", () => {
  const pendingId = `${PENDING_RUN_ID_PREFIX}1:0`;
  const pendingRun = (): ToolRun => ({
    id: pendingId,
    name: "write_file",
    argsSummary: "写入文件（生成中 120 字符）",
    status: "running",
    args: '{"path":"产物/总结.md", "content": "今天',
  });
  const pendingStep = (): AgentStep => ({ kind: "tool", run: pendingRun() });

  it("前缀合成行在全量列表在场时保留（参数流式帧）", () => {
    const steps = mergeToolRuns([T("叙述"), pendingStep()], [pendingRun()]);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ kind: "tool", run: { id: pendingId, status: "running" } });
  });

  it("同 id 真实工具行原位替换（参数分片首帧带 id 的常态）", () => {
    const partial: ToolRun = { ...pendingRun(), id: "call-1", argsSummary: "写入文件（生成中 12 字符）" };
    const real: ToolRun = {
      id: "call-1",
      name: "write_file",
      argsSummary: "写入 产物/总结.md",
      status: "running",
    };
    expect(mergeToolRuns([{ kind: "tool", run: partial }], [real])).toEqual([
      { kind: "tool", run: real },
    ]);
  });

  it("前缀合成行不在全量列表时剪除（收尾纯 allRuns，中止/出错不残留转圈行）", () => {
    expect(mergeToolRuns([T("叙述"), pendingStep()], [])).toEqual([T("叙述")]);
  });

  it("终态合成行不在全量列表时保留（已结算是历史记录，不随后续轮次丢失）", () => {
    const settled: ToolRun = { ...pendingRun(), status: "error", resultSummary: "（已中断）" };
    const steps = mergeToolRuns([T("叙述"), { kind: "tool", run: settled }], []);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({
      kind: "tool",
      run: { status: "error", resultSummary: "（已中断）" },
    });
  });

  it("无前缀的普通工具行不受剪除影响", () => {
    const merged = mergeToolRuns([tool("t1"), pendingStep()], [run("t1")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "tool", run: { id: "t1" } });
  });

  it("无合成行且 run 同引用时原样返回（不触发无谓重渲染）", () => {
    const r = run("t1");
    const steps: AgentStep[] = [T("叙述"), { kind: "tool", run: r }];
    expect(mergeToolRuns(steps, [r])).toBe(steps);
  });
});

describe("promoteTrailingNarration", () => {
  it("尾部叙述行提升进 content 并从 steps 移除（最终回答轮）", () => {
    expect(promoteTrailingNarration([R("想"), tool("t1"), T("最终回答")])).toEqual({
      content: "最终回答",
      steps: [R("想"), tool("t1")],
    });
  });

  it("多段尾部叙述行按序拼接提升", () => {
    expect(promoteTrailingNarration([R("想"), T("第一段"), T("第二段")])).toEqual({
      content: "第一段\n第二段",
      steps: [R("想")],
    });
  });

  it("工具/思考步后的尾部文本才提升（工具步之前的历史叙述不提升）", () => {
    const steps = [T("历史叙述"), tool("t1"), R("轮内思考"), T("回答")];
    expect(promoteTrailingNarration(steps)).toEqual({
      content: "回答",
      steps: [T("历史叙述"), tool("t1"), R("轮内思考")],
    });
  });

  it("无尾部文本步时原样返回空 content", () => {
    expect(promoteTrailingNarration([R("想"), tool("t1")])).toEqual({
      content: "",
      steps: [R("想"), tool("t1")],
    });
    expect(promoteTrailingNarration([])).toEqual({ content: "", steps: [] });
  });
});

describe("finalizeReplyText", () => {
  it("最终回答轮：尾部叙述提升进 content、移出 steps", () => {
    expect(
      finalizeReplyText({
        content: "",
        steps: [R("想"), tool("t1"), T("回答")],
        promoteNarration: true,
        truncated: false,
      }),
    ).toEqual({ content: "回答", steps: [R("想"), tool("t1")] });
  });

  it("非最终轮（promoteNarration=false）不提升", () => {
    expect(
      finalizeReplyText({
        content: "",
        steps: [R("想"), tool("t1"), T("叙述")],
        promoteNarration: false,
        truncated: false,
      }),
    ).toEqual({ content: "", steps: [R("想"), tool("t1"), T("叙述")] });
  });

  it("截断且有正文：尾部追加截断提示，提升后的步骤移除", () => {
    const res = finalizeReplyText({
      content: "",
      steps: [T("已生成的部分")],
      promoteNarration: true,
      truncated: true,
    });
    expect(res.content).toContain("已生成的部分");
    expect(res.content).toContain(TRUNCATED_TEXT);
    expect(res.steps).toEqual([]);
  });

  it("截断且正文为空：写 `[错误]` 截断占位", () => {
    expect(
      finalizeReplyText({
        content: "",
        steps: [R("想")],
        promoteNarration: false,
        truncated: true,
      }).content,
    ).toBe(`${ERROR_PREFIX} ${TRUNCATED_TEXT}`);
  });
});
