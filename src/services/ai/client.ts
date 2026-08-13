import type { Attachment, Role, ToolDef } from "@/types";
import {
  isRetryableError,
  isContextOverflow,
  OVERFLOW_HINT,
} from "@/utils/aiErrors";

/**
 * OpenAI 兼容协议的客户端。
 * 前端直连，SSE 流式输出。
 * key 由用户在设置中填入，本地加密存储，运行时解密到内存。
 */

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** AI 请求的工具调用（SSE delta 累积完成后的完整形态，OpenAI 规范结构）。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    /** assistant 带 tool_calls 时 content 为 null（OpenAI 规范，部分兼容网关对空串返回 500） */
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  /** 采样温度；不传 = 请求体不含该字段，使用各厂商 API 默认配置（无统一「推荐值」标准端点）。 */
  temperature?: number;
  /** 单次响应最大 token 数。仅短任务（如标题生成）显式传入，防兼容网关 n_predict=-1 无限生成；主对话不传（不截断回复）。 */
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ToolDef[];
  /** 传输级重试：仅在「请求未建立或未收到任何 SSE 事件」的失败上重试（网络抖动/5xx/限流）；
   * 流已开始后的中断不重试（防重复输出）。abort 后永不重试。缺省 = 不重试。 */
  retry?: {
    /** 最大重试次数（总尝试 = maxRetries + 1）。 */
    maxRetries?: number;
    /** 每次重试前回调（attempt 从 1 开始；供 UI 提示「正在重试」）。 */
    onRetry?: (attempt: number, delayMs: number) => void;
  };
}

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void;
  /** 流结束（含超时/中止）。stopReason = 服务端 finish_reason（"stop"/"length"/"tool_calls"/…），未提供为 undefined。 */
  onDone: (stopReason?: string) => void;
  onError: (err: Error) => void;
  /** 模型思考过程增量（`delta.reasoning_content`，思考型模型的推理阶段内容）。 */
  onReasoningDelta?: (text: string) => void;
  /** 响应含工具调用时触发（在 onDone 之前）。tool_calls 已按 index 累积完整。 */
  onToolCalls?: (calls: ToolCall[]) => void;
}

/** 流式空闲超时：SSE 长时间无新 token 视为挂起（后端异常/连接半死），调用方据此自动中止降级。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** 连通性测试/模型列表拉取超时：黑盒端点可能只收不答（代理吞包/黑洞 IP），防设置页按钮无限转圈。 */
export const FETCH_MODELS_TIMEOUT_MS = 15_000;

/** SSE 流中的 tool_calls delta（按 index 分段累积）。 */
interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** 服务端要求的重试延迟超过此值即放弃重试（服务器都觉得自己要挂 60s+，不值得等）。 */
const MAX_RETRY_DELAY_MS = 60_000;

/** 可中断睡眠：abort 时立即返回 false（调用方不再重试）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 重试延迟：优先服务端 retry-after 头（秒或 HTTP 日期），否则指数退避 0.5*2^n 秒 + 0-25% 抖动。 */
function retryDelayMs(attempt: number, res?: Response): number | null {
  if (res) {
    const raw = res.headers.get("retry-after");
    if (raw) {
      const secs = /^\d+$/.test(raw) ? Number(raw) : NaN;
      const ms = Number.isFinite(secs)
        ? secs * 1000
        : Number.isFinite(Date.parse(raw))
          ? Math.max(0, Date.parse(raw) - Date.now())
          : NaN;
      if (Number.isFinite(ms)) return ms > MAX_RETRY_DELAY_MS ? null : ms;
    }
  }
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base + Math.random() * base * 0.25;
}

/** 上下文溢出错误追加友好提示（防用户看到裸 API 报错不知所措）。 */
function withOverflowHint(err: Error): Error {
  if (isContextOverflow(err)) {
    return new Error(`${err.message}（${OVERFLOW_HINT}）`);
  }
  return err;
}

/** 单次请求尝试的结果：ok = 正常结束；fatal = 不可重试失败；retryable = 可重试的传输失败。 */
type AttemptResult =
  | { kind: "ok" }
  | { kind: "fatal"; err: Error }
  | { kind: "retryable"; err: Error; delayMs: number };

interface StreamRequest {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatParams["messages"];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ToolDef[];
}

/** 发起一次流式请求并消费整个 SSE 流（重试由 streamChat 外层循环负责）。 */
async function streamAttempt(
  req: StreamRequest,
  callbacks: ChatStreamCallbacks,
): Promise<AttemptResult> {
  const { url, apiKey, model, messages, temperature, maxTokens, signal, tools } = req;
  // 是否收到过有效 SSE 事件：重试只发生在「事件前失败」（传输层问题）；
  // 空流说明网关没按 stream 响应（兜底非流式解析或报错，不静默"成功"）
  let receivedAnyEvent = false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 自建网关无内置 SSE 时依赖此头决定以流式返回
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        // 不传 temperature = 使用各厂商 API 默认配置（无统一「推荐值」端点，交给厂商）
        temperature,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        stream: true,
        tools,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      // 错误信息带请求目标与 model，便于排查打错端点/模型名问题
      const bodyText = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} (${url} | model: ${model}): ${bodyText}`);
      if (isRetryableError(err)) {
        const delayMs = retryDelayMs(0, res);
        if (delayMs !== null) return { kind: "retryable", err, delayMs };
      }
      return { kind: "fatal", err };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    // 服务端 finish_reason（最后一个 chunk 携带，[DONE] 前收齐）
    let stopReason: string | undefined;
    // tool_calls 按 index 累积（SSE 分段 delta：id 只在首段、name/arguments 分段）
    const toolCallAcc: ToolCallDelta[] = [];

    const flushToolCalls = () => {
      const calls: ToolCall[] = toolCallAcc.map((t) => ({
        id: t.id ?? "",
        // type 恒为 "function"（当前仅 web_search/write_note 等函数工具）；llama.cpp 解析
        // assistant tool_calls 必须带该字段（缺失报 "Missing tool call type" 500）
        type: "function",
        function: { name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" },
      }));
      if (calls.length) callbacks.onToolCalls?.(calls);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件（兼容 \r\n\r\n 与 \n\n）
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          flushToolCalls();
          callbacks.onDone(stopReason);
          return { kind: "ok" };
        }
        try {
          const json = JSON.parse(data);
          // 部分兼容网关流式中途出错会发 error 事件（HTTP 仍是 200）——如实上报，不静默跳过
          if (json.error) {
            const err = json.error as { message?: string } | string;
            const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(json.error));
            throw new Error(`SSE 错误事件: ${msg}`);
          }
          receivedAnyEvent = true;
          const choice = json.choices?.[0];
          if (choice?.finish_reason) stopReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (delta.content) callbacks.onDelta(delta.content);
          // 思考过程增量：多字段探测（思考型模型在推理阶段只发思考字段，各家命名不一）
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
          if (reasoning) callbacks.onReasoningDelta?.(reasoning);
          // 工具调用：{ index, id?, function: { name?, arguments? } }，按 index 累积
          const tc = delta.tool_calls as ToolCallDelta[] | undefined;
          if (tc) {
            for (const t of tc) {
              const slot = toolCallAcc[t.index];
              if (slot) {
                if (t.id) slot.id = t.id;
                if (t.function?.name) slot.function = { ...slot.function, name: t.function.name };
                if (t.function?.arguments) {
                  slot.function = { ...slot.function, arguments: (slot.function?.arguments ?? "") + t.function.arguments };
                }
              } else {
                toolCallAcc[t.index] = {
                  index: t.index,
                  id: t.id,
                  function: t.function ? { name: t.function.name, arguments: t.function.arguments ?? "" } : undefined,
                };
              }
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("SSE 错误事件")) throw err;
          // 单帧解析失败跳过，不中断流
        }
      }
    }
    flushToolCalls();
    if (!receivedAnyEvent && buffer.trim()) {
      // 网关忽略 stream:true 直接返回了完整 JSON：按非流式兜底解析一次，避免"发了消息但毫无反应"
      try {
        const json = JSON.parse(buffer.trim());
        const text: unknown = json?.choices?.[0]?.message?.content;
        if (typeof text === "string" && text) {
          callbacks.onDelta(text);
          callbacks.onDone(stopReason);
          return { kind: "ok" };
        }
      } catch {
        // 不是 JSON：落报错分支
      }
      throw new Error("流式响应异常：未收到数据");
    }
    callbacks.onDone(stopReason);
    return { kind: "ok" };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      callbacks.onDone();
      return { kind: "ok" };
    }
    const e = err as Error;
    // 重试只对「流开始前」的失败生效（receivedAnyEvent = false）：流中错误事件/中断不重试，
    // 否则已渲染的增量会从零重复输出
    if (isRetryableError(e) && !receivedAnyEvent) {
      // catch 路径无 res：退避恒非 null（?? 0 仅为类型收窄）
      return { kind: "retryable", err: e, delayMs: retryDelayMs(0) ?? 0 };
    }
    // 溢出提示统一由 streamChat 的 onError 出口包裹一次（此处不包，防双重「（上下文过长…）」）
    return { kind: "fatal", err: e };
  }
}

/**
 * 发起流式聊天请求。
 * 失败降级策略：可重试的传输级失败（网络/5xx/429）按指数退避重试（尊重服务端 retry-after），
 * 其余失败统一走 onError（溢出错误附友好提示）；abort 后永不重试、按 onDone 正常收敛。
 */
export async function streamChat(
  params: ChatParams,
  callbacks: ChatStreamCallbacks,
): Promise<void> {
  const { baseUrl, apiKey, model, messages, temperature, maxTokens, signal, tools, retry } = params;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const maxRetries = retry?.maxRetries ?? 0;

  for (let attempt = 0; ; attempt++) {
    const result = await streamAttempt(
      { url, apiKey, model, messages, temperature, maxTokens, signal, tools },
      callbacks,
    );
    if (result.kind === "ok") return;
    // 用户已中止（含重试等待期间）：按 onDone 收敛，不报错不重试
    if (signal?.aborted) {
      callbacks.onDone();
      return;
    }
    if (result.kind === "fatal" || attempt >= maxRetries) {
      callbacks.onError(withOverflowHint(result.err));
      return;
    }
    retry?.onRetry?.(attempt + 1, result.delayMs);
    const waited = await sleep(result.delayMs, signal);
    if (!waited) {
      callbacks.onDone();
      return;
    }
  }
}

/**
 * 发起非流式单次聊天请求，返回完整回复文本（用于标题生成等一次性任务）。
 * 边界捕获：网络/解析失败抛错，由调用方降级。
 */
export async function chatOnce(params: ChatParams): Promise<string> {
  const { baseUrl, apiKey, model, messages, temperature, maxTokens, signal } = params;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      // 不传 temperature = 使用各厂商 API 默认配置
      temperature,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    throw withOverflowHint(err);
  }
  const json = await res.json();
  const text: unknown = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("响应缺少 content");
  }
  return text;
}

/**
 * 拉取供应商可用模型列表（`GET {baseUrl}/models`，OpenAI 兼容标准端点）。
 * 同时用作设置页「获取模型列表」与「测试连通性」（端点可达 + key 有效，免计费）。
 * 边界捕获：网络/解析失败抛错（带 HTTP 状态与响应摘要），由调用方降级提示。
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} (${url}): ${await res.text().catch(() => "")}`,
      );
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (!ids.length) {
      throw new Error("响应中没有模型列表（data 为空）");
    }
    return ids;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("请求超时（15 秒），请检查 Base URL 与网络");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将内部消息（画布 `Message[]` / 对话面板 `EditorChatMessage[]`）转为 OpenAI 兼容 messages 数组。
 * 纯数据转换，不做 I/O，内部信任。
 *
 * 注入语义（一次性固化，不使用 system）：
 * - 文本/搜索引用在 send 时已拼进对应 user 消息 content（`[引用：…]` 前缀），此函数不再拼接。
 *   历史每轮重发即可，未来消息不重复注入。
 * - 图片附件挂到对应 user 消息的 content 数组（vision），进历史后被重发，无需重复注入。
 */
export function toApiMessages(
  messages: Array<{ role: Role; content: string; attachments?: Attachment[] }>,
): ChatParams["messages"] {
  return messages.map((m) => {
    if (m.role === "user" && m.attachments?.length) {
      return {
        role: "user",
        content: [
          { type: "text" as const, text: m.content },
          ...m.attachments.map((a): ContentPart =>
            a.kind === "image"
              ? { type: "image_url", image_url: { url: a.payload } }
              : { type: "text", text: a.payload }
          ),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}
