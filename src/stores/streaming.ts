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
  type ToolDef,
} from "@/services/ai/client";
import type { ProviderConfig } from "@/types";

export interface StreamBatch {
  content: string;
  reasoning: string;
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
  /** 工具执行（画布 = 搜索 + 建产物节点；面板 = 仅搜索回填），返回 tool 消息由引擎回填下一轮。 */
  executeTools: (calls: ToolCall[]) => Promise<ChatParams["messages"]>;
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
          onDone: () => {
            // 清理在循环外统一做（工具轮的占位不能提前移除）
          },
          onError: (err) => {
            roundError = err;
          },
        },
      );

      if (roundError) {
        cancelRaf();
        clearIdle();
        options.onError(roundError);
        return;
      }

      if (toolCalls.length === 0) break; // 纯文本轮：流式内容已写入占位

      // 执行工具调用（搜索走 Rust 代理，invoke 不支持 AbortSignal）：用户点停止后，已发出的
      // 请求结果回来时被下方 aborted 检查丢弃（不建产物），下一轮携已 abort 的 signal 立即收敛
      const toolMessages = await options.executeTools(toolCalls);
      if (signal.aborted) break;
      // 已达工具上限：本轮工具已执行（结果已沉淀），不再回填继续请求
      if (round >= maxRounds) break;
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
