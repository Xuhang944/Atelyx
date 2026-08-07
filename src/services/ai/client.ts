import type { Attachment, Role } from "@/types";

/**
 * OpenAI 兼容协议的客户端。
 * 前端直连，SSE 流式输出。
 * key 由用户在设置中填入，本地加密存储，运行时解密到内存。
 */

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** OpenAI 兼容 function 定义（联网搜索工具，）。 */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

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
}

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
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

/**
 * 发起流式聊天请求。
 * 边界捕获：网络/解析失败统一走 onError 降级。
 */
export async function streamChat(
  params: ChatParams,
  callbacks: ChatStreamCallbacks
): Promise<void> {
  const { baseUrl, apiKey, model, messages, temperature, maxTokens, signal, tools } = params;
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

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
      throw new Error(`HTTP ${res.status} (${url} | model: ${model}): ${bodyText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    // 是否收到过有效 SSE 事件：空流说明网关没按 stream 响应（兜底非流式解析或报错，不静默"成功"）
    let receivedAnyEvent = false;
    // tool_calls 按 index 累积（SSE 分段 delta：id 只在首段、name/arguments 分段）
    const toolCallAcc: ToolCallDelta[] = [];

    const flushToolCalls = () => {
      const calls: ToolCall[] = toolCallAcc.map((t) => ({
        id: t.id ?? "",
        // type 恒为 "function"（当前仅定义 web_search 一个函数工具）；llama.cpp 解析
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
          callbacks.onDone();
          return;
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
          const choice = json.choices?.[0]?.delta;
          if (!choice) continue;
          const delta = choice.content;
          if (delta) callbacks.onDelta(delta);
          // 思考过程增量（思考型模型在推理阶段只发 reasoning_content）
          const reasoning = choice.reasoning_content;
          if (reasoning) callbacks.onReasoningDelta?.(reasoning);
          // 工具调用：{ index, id?, function: { name?, arguments? } }，按 index 累积
          const tc = choice.tool_calls as ToolCallDelta[] | undefined;
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
          callbacks.onDone();
          return;
        }
      } catch {
        // 不是 JSON：落报错分支
      }
      throw new Error("流式响应异常：未收到数据");
    }
    callbacks.onDone();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      callbacks.onDone();
      return;
    }
    callbacks.onError(err as Error);
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
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
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
