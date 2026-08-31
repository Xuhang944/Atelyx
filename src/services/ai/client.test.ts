/**
 * OpenAI 兼容适配器契约测试（services/ai/client）。
 *
 * 核心回归：工具调用参数分片以 `tool-call-delta` 逐片发出（参数进度实时可见、空闲超时可喂狗），
 * 完整调用仍在流末一次性发出（工具执行只认完整调用）；`streamChat` 把增量原样转发给
 * `onToolCallDelta`，`onToolCalls` 仍只在流末触发一次（引擎据此把「生成中」行固化为正式行）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat, streamRequest } from "./client";
import type { LlmStreamEvent } from "@/types";

const encoder = new TextEncoder();

/** 构造 SSE 响应（逐帧 enqueue 后关闭）。 */
function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const data = (json: unknown): string => `data: ${JSON.stringify(json)}\n\n`;

const REQ = {
  url: "https://example.test/v1/chat/completions",
  apiKey: "key",
  model: "test-model",
  messages: [{ role: "user" as const, text: "hi" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamRequest 工具调用参数分片", () => {
  it("tool_calls 分片逐片发 tool-call-delta，流末一次性发完整 tool-call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          data({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: '{"path":' } }] } },
            ],
          }),
          data({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] } }],
          }),
          data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const events: LlmStreamEvent[] = [];
    for await (const e of streamRequest(REQ)) events.push(e);

    expect(events).toEqual([
      { type: "tool-call-delta", index: 0, id: "call-1", name: "write_file", argumentsDelta: '{"path":' },
      { type: "tool-call-delta", index: 0, argumentsDelta: '"a.md"}' },
      { type: "tool-call", call: { id: "call-1", name: "write_file", arguments: '{"path":"a.md"}' } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("纯文本流不受影响（text-delta + finish stop，无工具增量）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          data({ choices: [{ delta: { content: "你" } }] }),
          data({ choices: [{ delta: { content: "好" } }] }),
          data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const events: LlmStreamEvent[] = [];
    for await (const e of streamRequest(REQ)) events.push(e);

    expect(events).toEqual([
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      { type: "finish", reason: "stop" },
    ]);
  });
});

describe("streamChat 回调转发", () => {
  it("参数增量转发 onToolCallDelta，完整调用仍只在流末 onToolCalls 一次", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          data({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: '{"path":' } }] } },
            ],
          }),
          data({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] } }],
          }),
          data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]\n\n",
        ]),
      ),
    );

    const deltas: unknown[] = [];
    let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let doneReason: string | undefined;
    await streamChat(
      { baseUrl: REQ.url, apiKey: REQ.apiKey, model: REQ.model, messages: [...REQ.messages] },
      {
        onDelta: () => {},
        onError: (e) => {
          throw e;
        },
        onDone: (reason) => {
          doneReason = reason;
        },
        onToolCallDelta: (d) => deltas.push(d),
        onToolCalls: (c) => {
          toolCalls = c;
        },
      },
    );

    expect(deltas).toHaveLength(2);
    expect(toolCalls).toEqual([{ id: "call-1", name: "write_file", arguments: '{"path":"a.md"}' }]);
    expect(doneReason).toBe("tool-calls");
  });
});
