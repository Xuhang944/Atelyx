/**
 * 公共流式对话引擎：画布对话节点（canvasStore.runStream）与 AI 对话面板（chatPanelStore.runExchange）共用。
 *
 * 一轮完整流式对话 = 可选工具循环（function calling）+ 双通道 rAF 节流 + 空闲超时 + SSE 流式。
 * 状态容器差异（messagesByConv vs sessions）由调用方回调消化：
 * - applyBatch：每帧合并后的增量写回调
 * - onError：请求失败写 [错误] 占位（保留已产出内容）
 * - onDone：流结束（含超时/中止），调用方用 decideCleanup 做最终清理
 * - executeTools：工具执行（画布 = 搜索 + 建产物节点；面板 = 仅搜索回填），返回 tool 消息由引擎回填下一轮
 */
import {
  streamChat,
  STREAM_IDLE_TIMEOUT_MS,
  type ChatParams,
  type ToolCall,
} from "@/services/ai/client";
import { autoTitle, AUTO_NAMING_DELAY_MS } from "@/services/ai/autoTitle";
import { summarizeToolArgs } from "@/constants/tools";
import { useSettingsStore } from "./settingsStore";
import type { ProviderConfig, Role, ToolDef, ToolRun } from "@/types";

export interface StreamBatch {
  content: string;
  reasoning: string;
}

/** 单个工具执行的结果（可视化用：与 tool call id 对应）。 */
export interface ToolExecResult {
  id: string;
  ok: boolean;
  summary: string;
}

export interface RunStreamExchangeOptions {
  provider: ProviderConfig;
  model: string;
  apiMessages: ChatParams["messages"];
  /** 传入 = 启用工具循环（最多 maxToolRounds 轮 + 1 次强制纯文本）；不传 = 单轮。 */
  tools?: ToolDef[];
  /** 工具执行轮数上限（防死循环），默认 3。 */
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
   * 工具执行（画布/面板均走 toolRunner 公共执行器，产物节点差异由调用方 hooks 消化），
   * 返回 tool 消息由引擎回填下一轮，results 为各 tool call 的执行结果摘要（可视化用）。
   */
  executeTools: (
    calls: ToolCall[],
  ) => Promise<{ messages: ChatParams["messages"]; results: ToolExecResult[] }>;
  /** 工具调用过程通知（可视化）：执行前发 running，执行后发 done/error。 */
  onToolRuns?: (runs: ToolRun[]) => void;
}

export async function runStreamExchange(
  options: RunStreamExchangeOptions,
): Promise<void> {
  const maxRounds = options.maxToolRounds ?? 3;
  let apiMessages = options.apiMessages;

  // 引擎内部 controller：空闲超时用内部 abort；外部 signal（停止按钮/切画布）变化时转发中止
  const controller = new AbortController();
  options.signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  const signal = controller.signal;

  // 双通道累积（本地变量与 applyBatch 同步累计；onDone 直接取本地值，不依赖调用方状态读取）
  let totalContent = "";
  let totalReasoning = "";
  let pendingDelta = "";
  let pendingReasoning = "";
  let rafId: number | null = null;

  const applyBatch = (content: string, reasoning: string) => {
    totalContent += content;
    totalReasoning += reasoning;
    options.applyBatch({ content, reasoning });
  };
  const flushPending = () => {
    const d = pendingDelta;
    const r = pendingReasoning;
    if (!d && !r) return;
    pendingDelta = "";
    pendingReasoning = "";
    applyBatch(d, r);
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
      let toolCalls: ToolCall[] = [];
      let stopReason: string | undefined;
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
          messages: apiMessages,
          signal,
          ...(toolsForRound.length ? { tools: toolsForRound } : {}),
          // 传输级重试：网络抖动/5xx/429 自动退避重试（最多 2 次；流开始后不重试，防重复输出）
          retry: { maxRetries: 2 },
        },
        {
          onDelta: (delta) => {
            pendingDelta += delta;
            resetIdle();
            scheduleApply();
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

      if (toolCalls.length === 0) break; // 纯文本轮：流式内容已写入占位

      // 回复被截断（finish_reason=length）：tool call 参数可能残缺，不执行工具
      // （防残缺参数执行产生误导产物），如实报错由调用方写 [错误] 占位
      if (stopReason === "length") {
        cancelRaf();
        clearIdle();
        options.onError(
          new Error("回复被截断（达到输出上限），工具调用未执行，请重试"),
        );
        return;
      }

      // 执行工具调用（走公共执行器 runToolCalls，画布/面板差异由 executeTools 回调消化）：
      // 用户点停止后，已发出的请求结果回来时被下方 aborted 检查丢弃（不建产物），
      // 下一轮携已 abort 的 signal 立即收敛
      const runningRuns: ToolRun[] = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argsSummary: summarizeToolArgs(tc.function.name, tc.function.arguments),
        status: "running",
      }));
      options.onToolRuns?.(runningRuns);
      const { messages: toolMessages, results } = await options.executeTools(toolCalls);
      if (signal.aborted) {
        // 中止：工具结果不回填，但 toolRuns 归一化为终止态（否则 running 状态随消息落盘，
        // 画布重开后工具块永久转圈；面板解析侧另有同款归一化兜底）
        options.onToolRuns?.(
          runningRuns.map((run) => ({
            ...run,
            status: "error" as const,
            resultSummary: "（已中断）",
          })),
        );
        break;
      }
      // 执行完成：running → done/error + 结果摘要（可视化块实时更新）
      options.onToolRuns?.(
        runningRuns.map((run) => {
          const res = results.find((r) => r.id === run.id);
          return {
            ...run,
            status: res && !res.ok ? ("error" as const) : ("done" as const),
            resultSummary: res?.summary ?? "完成",
          };
        }),
      );
      // 已达工具上限：本轮工具已执行（结果已沉淀），不再回填继续请求
      // （末轮 toolsForRound 恒为空、toolCalls 恒为空，178 行已 break——此处无需守卫）
      apiMessages = [
        ...apiMessages,
        // OpenAI 规范：assistant 带 tool_calls 时 content 为 null（部分兼容网关对空串返回 500）
        { role: "assistant", content: null, tool_calls: toolCalls },
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
  }
}

export type CleanupDecision =
  { kind: "remove" } | { kind: "timeout-error" } | { kind: "keep" };

/** 结束清理决策（画布/面板共用）：空回复移除占位；超时且回答未产出写超时错误（保留思考）；否则保留。 */
export function decideCleanup(
  content: string,
  reasoning: string,
  timedOut: boolean,
): CleanupDecision {
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
  opts?: { delayMs?: number; maxChars?: number; ignoreToggle?: boolean },
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
  // 命名不传 temperature：交给厂商 API 默认配置（与主对话一致）
  const { aborted, title } = await autoTitle(
    { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model },
    dialogue,
    { maxChars: opts?.maxChars },
  );
  if (aborted) return "skipped";
  if (!title) return "failed";
  // 命名期间目标可能已命名/已删除 → 校验后再写，防并发覆盖
  if (target.isNamed()) return "skipped";
  target.applyTitle(title);
  return "ok";
}
