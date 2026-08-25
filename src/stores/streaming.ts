/**
 * 公共流式对话引擎：画布对话节点（canvasStore.runStream）与 AI 对话面板（chatPanelStore.runExchange）共用。
 *
 * 一轮完整流式对话 = 可选工具循环（function calling）+ 双通道 rAF 节流 + 空闲超时 + SSE 流式。
 * 状态容器差异（messagesByConv vs sessions）由调用方回调消化：
 * - applyBatch：每帧合并后的增量写回调
 * - onError：请求失败写 [错误] 占位（保留已产出内容）
 * - onDone：流结束（含超时/中止），调用方用 decideCleanup 做最终清理
 * - executeTools：工具执行（走公共执行器 runAgentTools，产物节点差异由调用方 hooks 消化），返回 tool 消息由引擎回填下一轮
 *
 * 类型全部用中性词汇（LlmMessage/ToolSchema），工具执行走 services/ai/tools 注册表（runAgentTools）。
 */
import { streamChat, STREAM_IDLE_TIMEOUT_MS } from "@/services/ai/client";
import { autoTitle, AUTO_NAMING_DELAY_MS } from "@/services/ai/autoTitle";
import { summarizeAgentTool } from "@/services/ai/tools";
import { useSettingsStore } from "./settingsStore";
import type {
  ProviderConfig,
  ReasoningEffort,
  Role,
  ToolSchema,
  LlmMessage,
  LlmToolCall,
  LlmFinishReason,
  ToolRun,
} from "@/types";

export interface StreamBatch {
  content: string;
  reasoning: string;
}

/** 单个工具执行的结果（可视化用：与 tool call id 对应）。 */
export interface ToolExecResult {
  id: string;
  ok: boolean;
  summary: string;
  /** 完整结果文本（展开详情用；缺省 = summary）。 */
  detail?: string;
}

/**
 * 工具调用轮数安全上限（默认）：只要模型还在调用工具就继续往下走，
 * 不让固定的小轮数把多步任务中途掐断；此值仅作防死循环的安全阀，模型自会在输出不带工具
 * 的正文时收束。到顶后引擎会进行一次强制纯文本轮给最终回答机会。
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 20;

export interface RunStreamExchangeOptions {
  provider: ProviderConfig;
  model: string;
  apiMessages: LlmMessage[];
  /** 思考档位：下发 `reasoning_effort` 以开启模型思考（仅对支持思考的模型生效）；缺省 = 不指定。 */
  reasoningEffort?: ReasoningEffort;
  /** 传入 = 启用工具循环（最多 maxToolRounds 轮 + 1 次强制纯文本）；不传 = 单轮。 */
  tools?: ToolSchema[];
  /** 工具执行轮数上限（防死循环），默认 `DEFAULT_MAX_TOOL_ROUNDS`（20）。到顶会有一轮强制纯文本收束。 */
  maxToolRounds?: number;
  signal: AbortSignal;
  applyBatch: (batch: StreamBatch) => void;
  onError: (err: Error) => void;
  onDone: (result: {
    content: string;
    reasoning: string;
    timedOut: boolean;
  }) => void;
  /**
   * 工具执行（画布/面板均走 services/ai/tools 的 runAgentTools，产物节点差异由调用方 hooks 消化），
   * 返回 tool 消息由引擎回填下一轮，results 为各 tool call 的执行结果摘要（可视化用）。
   */
  executeTools: (
    calls: LlmToolCall[],
  ) => Promise<{ messages: LlmMessage[]; results: ToolExecResult[] }>;
  /** 工具调用过程通知（可视化）：跨轮**全量**累积列表，执行前发 running、执行后发 done/error（调用方 mergeToolRuns 交错进 steps）。 */
  onToolRuns?: (runs: ToolRun[]) => void;
  /**
   * 工具轮的叙述正文增量通知：每轮在调用工具前说的普通文本**边生成边**追加为一个「叙述行」text 步
   * （不是缓冲到轮末，从而保留流式打字效果），不进 content。
   */
  onNarration?: (text: string) => void;
}

export async function runStreamExchange(
  options: RunStreamExchangeOptions,
): Promise<void> {
  const maxRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  let apiMessages = options.apiMessages;

  // 引擎内部 controller：空闲超时用内部 abort；外部 signal（停止按钮/切画布）变化时转发中止。
  // 注意：addEventListener 不会对「调用前已 aborted」的信号回放事件，须显式补一次检查
  const controller = new AbortController();
  if (options.signal.aborted) controller.abort();
  options.signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const signal = controller.signal;

  // 双通道累积（本地变量与 applyBatch 同步累计；onDone 直接取本地值，不依赖调用方状态读取）
  let totalContent = "";
  let totalReasoning = "";
  let pendingDelta = "";
  let pendingReasoning = "";
  // 工具轮叙述正文增量（rAF 合并，避免每 token 一次 setState；与 content/reasoning 同一条 merge 通道）
  let pendingNarration = "";
  let rafId: number | null = null;
  // 工具调用过程跨轮累积：每轮 onToolRuns 发全量，供调用方 mergeToolRuns 交错进 steps——
  // 否则多轮工具循环只显示最后一轮（调用方整体替换）。
  // **随结算重写为 `let`**：done/中止时回写 allRuns，finally 兜底只能命中「真未回填」的工具，不误标已完成
  let allRuns: ToolRun[] = [];

  const applyBatch = (content: string, reasoning: string) => {
    totalContent += content;
    totalReasoning += reasoning;
    options.applyBatch({ content, reasoning });
  };
  const flushPending = () => {
    const d = pendingDelta;
    const r = pendingReasoning;
    const n = pendingNarration;
    pendingDelta = "";
    pendingReasoning = "";
    pendingNarration = "";
    if (n) options.onNarration?.(n);
    if (d || r) applyBatch(d, r);
  };
  const scheduleApply = () => {
    if (rafId === null)
      rafId = requestAnimationFrame(() => {
        rafId = null;
        flushPending();
      });
  };
  const cancelRaf = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  // 空闲超时：每个增量重置，超时无新 token 视为挂起（后端异常/连接半死），自动中止降级
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      timedOut = true;
      controller.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  try {
    for (let round = 0; round <= maxRounds; round++) {
      let toolCalls: LlmToolCall[] = [];
      let stopReason: LlmFinishReason | undefined;
      let roundError: Error | null = null;
      // 最后一轮不带 tools：强制纯文本回复，保证占位消息有内容（否则连续工具调用会「只出工具产物、无 AI 回复」）
      const toolsForRound =
        options.tools && round < maxRounds ? options.tools : [];
      // 请求发起即开始空闲计时（首个 token 前的等待也受超时保护）
      resetIdle();
      await streamChat(
        {
          baseUrl: options.provider.baseUrl,
          apiKey: options.provider.apiKey,
          model: options.model,
          ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
          messages: apiMessages,
          signal,
          ...(toolsForRound.length ? { tools: toolsForRound } : {}),
          // 传输级重试：网络抖动/5xx/429 自动退避重试（最多 2 次；流开始后不重试，防重复输出）
          retry: { maxRetries: 2 },
        },
        {
          onDelta: (delta) => {
            // 工具可用轮（含可能调用工具的轮次）里正文是「叙述」，缓冲后 rAF 合并进 text 步（保留流式打字）；
            // 仅末轮（强制纯文本）的正文实时进 content（最终回复）
            if (toolsForRound.length) pendingNarration += delta;
            else pendingDelta += delta;
            scheduleApply();
            resetIdle();
          },
          onReasoningDelta: (text) => {
            pendingReasoning += text;
            resetIdle();
            scheduleApply();
          },
          onToolCalls: (tc) => {
            toolCalls = tc;
          },
          onDone: (sr) => {
            // 清理在循环外统一做（工具轮的占位不能提前移除）
            stopReason = sr;
          },
          onError: (err) => {
            roundError = err;
          },
        },
      );

      // 空闲超时只覆盖「等待 token」阶段：streamChat 一结束立即收掉计时器，
      // 否则计时器贯穿 executeTools——慢工具执行（搜索等）会被误判挂起中止
      clearIdle();

      if (roundError) {
        cancelRaf();
        clearIdle();
        options.onError(roundError);
        return;
      }

      if (toolCalls.length === 0) {
        // 纯文本轮：强制末轮正文已实时进 content；工具可用轮里模型直接回答（未调工具）时，
        // 其正文留在 pendingNarration，由循环外统一 flush 成 text 步（叙述行，Markdown 正文渲染）
        break;
      }

      // 回复被截断（finish_reason=length → 中性 max-tokens）：tool call 参数可能残缺，不执行工具
      // （防残缺参数执行产生误导产物），如实报错由调用方写 [错误] 占位
      if (stopReason === "max-tokens") {
        cancelRaf();
        clearIdle();
        options.onError(
          new Error("回复被截断（达到输出上限），工具调用未执行，请重试"),
        );
        return;
      }

      // 执行工具调用（走公共执行器 runAgentTools，画布/面板差异由 executeTools 回调消化）：
      // 用户点停止后，已发出的请求结果回来时被下方 aborted 检查丢弃（不建产物），
      // 下一轮携已 abort 的 signal 立即收敛
      const runningRuns: ToolRun[] = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argsSummary: summarizeAgentTool(tc.name, tc.arguments),
        args: tc.arguments,
        status: "running",
      }));
      // 先 flush 当轮思考与叙述再发工具步：思考/叙述增量经 rAF 异步落 steps，若不同步 flush，
      // 工具步会先于其思考/叙述进入 steps（整条消息「工具一串、思考堆在后」分不清对应哪步）
      cancelRaf();
      flushPending();
      // 跨轮累积后发全量：调用方合并进 steps（多轮思考→工具交错展示）
      allRuns.push(...runningRuns);
      options.onToolRuns?.([...allRuns]);
      const { messages: toolMessages, results } = await options.executeTools(toolCalls);
      if (signal.aborted) {
        // 中止：工具结果不回填，但 running 态归一化为「（已中断）」error（否则 running 状态随消息落盘，
        // 画布重开后工具块永久转圈；面板解析侧另有同款归一化兜底）；已完成记录保留
        allRuns = allRuns.map((run) =>
          run.status === "running"
            ? { ...run, status: "error" as const, resultSummary: "（已中断）" }
            : run,
        );
        options.onToolRuns?.([...allRuns]);
        break;
      }
      // 执行完成：running → done/error + 结果摘要（可视化块实时更新）。
      // **回写 allRuns**（新对象，引用变化触发气泡重渲染），finally 兜底据此只处理真未回填的工具
      allRuns = allRuns.map((run) => {
        const res = results.find((r) => r.id === run.id);
        if (!res) return run; // 前几轮已完成记录，原样保留
        return {
          ...run,
          status: res.ok ? ("done" as const) : ("error" as const),
          resultSummary: res.summary ?? "完成",
          result: res.detail ?? res.summary,
        };
      });
      options.onToolRuns?.([...allRuns]);
      // 已达工具上限：本轮工具已执行（结果已沉淀），不再回填继续请求
      // （末轮 toolsForRound 恒为空、toolCalls 恒为空，上面已 break——此处无需守卫）
      apiMessages = [
        ...apiMessages,
        // 中性语义：assistant 带 toolCalls 时 text 为 null（适配器转 OpenAI 线时 content 为 null，
        // 部分兼容网关对空串返回 500）
        { role: "assistant", text: null, toolCalls },
        ...toolMessages,
      ];
    }

    cancelRaf();
    clearIdle();
    flushPending();
    options.onDone({
      content: totalContent,
      reasoning: totalReasoning,
      timedOut,
    });
  } catch (e) {
    cancelRaf();
    clearIdle();
    options.onError(e as Error);
  } finally {
    // 收尾兜底：任何原因（异常/结果缺失）下仍在 running 的工具行归一到终态，保证 UI 不会永久转圈。
    // 仅在确有 running 残留时才发（正常路径已全部 done，不 re-emit，避免误标已完成工具）
    if (allRuns.some((r) => r.status === "running")) {
      options.onToolRuns?.(
        allRuns.map((run) =>
          run.status === "running"
            ? { ...run, status: "error" as const, resultSummary: "（结果未回填）" }
            : run,
        ),
      );
    }
  }
}

export type CleanupDecision =
  { kind: "remove" } | { kind: "timeout-error" } | { kind: "keep" };

/** 结束清理决策（画布/面板共用）：空回复移除占位；超时且回答未产出写超时错误（保留思考）；否则保留。
 *  `hasSteps`：已产出叙述/工具步骤（steps）时即便最终正文为空也保留——agent 的过程不该被整条删掉。 */
export function decideCleanup(
  content: string,
  reasoning: string,
  timedOut: boolean,
  hasSteps = false,
): CleanupDecision {
  if (hasSteps) return { kind: "keep" };
  if (!content.trim() && !reasoning.trim()) {
    return timedOut ? { kind: "timeout-error" } : { kind: "remove" };
  }
  if (!content.trim() && timedOut) return { kind: "timeout-error" };
  return { kind: "keep" };
}

/**
 * 话题命名目标（画布对话节点 / AI 对话面板会话的差异由回调注入，命名管线共用一份）。
 * 回调在延迟后与写回前被重取——命名期间的新消息纳入摘要、已命名/已删除则不写。
 */
export interface AutoNameTarget {
  /** 重取当前消息列表（延迟后调用；目标已消失返回空数组）。 */
  getMessages: () => Array<{ role: Role; displayContent?: string; content: string }>;
  /** 是否已被命名（画布 = 节点 title 非空；面板 = 已登记成功命名）。 */
  isNamed: () => boolean;
  /** 写回标题（画布 = updateNodeData；面板 = 更新会话 + 登记 + 落盘）。 */
  applyTitle: (title: string) => void;
}

export type AutoNamingResult = "ok" | "skipped" | "failed";

/**
 * 公共话题命名管线（画布/面板共用，两 store 的 autoNameConversation/autoNameSession 均收敛于此）：
 * 解析命名模型（设置指定 → 仓库默认；关闭/未配置返回 skipped）→ 可选延迟（缺省 3s 防限流；
 * 重新命名传 0 立即发出）→ 消息检查（user + assistant 各一）→ LLM 生成（超时 60s /
 * 可选全量历史）→ 二次校验未命名再写回。
 * 返回：ok = 成功写回；skipped = 无模型/无消息/已命名/被主动中止（调用方静默）；
 * failed = LLM 请求失败（调用方提示可重试）。
 * `ignoreToggle` = 重新命名：不受「话题自动命名」开关限制（用户显式请求）。
 */
export async function runAutoNaming(
  target: AutoNameTarget,
  opts?: { delayMs?: number; maxChars?: number; ignoreToggle?: boolean; key?: string },
): Promise<AutoNamingResult> {
  const named = useSettingsStore.getState().resolveAutoNamingModel(opts?.ignoreToggle);
  if (!named) return "skipped";
  const delay = opts?.delayMs ?? AUTO_NAMING_DELAY_MS;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  if (target.isNamed()) return "skipped";
  const messages = target.getMessages();
  // 至少 user + assistant 各一才有摘要意义（纯 user 未回复/abort 未产出——下轮再试）
  if (
    !messages.some((m) => m.role === "user") ||
    !messages.some((m) => m.role === "assistant")
  ) {
    return "skipped";
  }
  const { provider, model } = named;
  const dialogue = messages
    .map((m) => `${m.role === "user" ? "用户" : "AI"}：${m.displayContent ?? m.content}`)
    .join("\n");
  // 命名不传 temperature：交给厂商 API 默认配置（与主对话一致）；
  // key = 目标标识（会话 id/对话节点 id）：abortAutoTitle(key) 只中止对应目标的命名请求
  const { aborted, title } = await autoTitle(
    { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model },
    dialogue,
    {
      maxChars: opts?.maxChars,
      ...(opts?.key ? { key: opts.key } : {}),
    },
  );
  if (aborted) return "skipped";
  if (!title) return "failed";
  // 命名期间目标可能已命名/已删除 → 校验后再写，防并发覆盖
  if (target.isNamed()) return "skipped";
  target.applyTitle(title);
  return "ok";
}
