import { describe, expect, test } from "vite-plus/test";

import { collect } from "@vibevalley/async";

import { jsonText } from "../base/json.ts";
import type { Context } from "../base/messages.ts";
import { models } from "../base/models.ts";
import { chunk, http, type Sent } from "../testing/testing.ts";
import { complete, deepseek, MissingKey } from "./client.ts";
import { LlmError, makeLlm } from "./llm.ts";
import { requestBody } from "./request.ts";

const flash = models[0];
const context: Context = { system: "你是助手。", tools: [], messages: [{ role: "user", content: "你好", timestamp: 1 }] };
const answer = chunk({ reasoning_content: "想" }) + chunk({ content: "你" }) + chunk({ content: "好" }) + chunk({}, "stop") + "data: [DONE]\n\n";

const llmOn = (fetch: typeof globalThis.fetch) => makeLlm({ fetch });

const failureOf = async (p: Promise<unknown>): Promise<LlmError> => {
  const e = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(e instanceof LlmError)) throw new Error(`expected an LlmError, got ${String(e)}`);
  return e;
};

describe("Llm", () => {
  test("keeps the original network cause and makes no retry or provider fallback", async () => {
    let requests = 0;
    let original: Error | undefined;
    const offline: typeof fetch = () => {
      requests++;
      original = new TypeError("fetch failed: offline");
      return Promise.reject(original);
    };
    const llm = llmOn(offline);
    const error = await failureOf(collect(llm.stream(flash, context, { apiKey: "fixture" })));
    expect(error.reason).toBe("network");
    expect(error.message).toBe(`Connection error: ${original?.message}`);
    expect(error.cause).toBe(original);
    expect(error.partial).toBeUndefined();
    expect(requests).toBe(1);
  });

  test("keeps the partial answer on a vendor stream error without retrying", async () => {
    const sent: Sent[] = [];
    const llm = llmOn(http(sent, chunk({ content: "partial" }) + 'data: {"error":{"message":"fixture refusal"}}\n\n'));
    const message = await llm.complete(flash, context, { apiKey: "fixture" });
    expect(message.content).toEqual([{ type: "text", text: "partial" }]);
    expect([message.stopReason, message.errorMessage]).toEqual(["error", "fixture refusal"]);
    expect(sent).toHaveLength(1);
  });

  test("cancels the response reader when the consumer stops after a text delta", async () => {
    const sent: Sent[] = [];
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk({ content: "partial" })));
      },
      cancel() {
        cancelled++;
      },
    });
    const llm = llmOn(http(sent, body));
    const events: string[] = [];
    for await (const event of llm.stream(flash, context, { apiKey: "fixture" })) {
      events.push(event.type);
      if (events.length === 3) break;
    }
    expect(events).toEqual(["start", "text_start", "text_delta"]);
    expect(sent).toHaveLength(1);
    expect(cancelled).toBe(1);
  });

  test("reads a replaced caller key for each request and preserves explicit unknown model IDs", async () => {
    const sent: Sent[] = [];
    const llm = llmOn(http(sent, answer));
    let key = "first";
    expect(() => deepseek("", "", llm)).toThrow(MissingKey);
    const client = deepseek("explicit-model", () => key, llm);
    await complete(client, context);
    key = "second";
    await complete(client, context);
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer first", "Bearer second"]);
    expect(sent.map((request) => request.body)).toEqual([requestBody(client.model, context), requestBody(client.model, context)]);
    expect(client.model.id).toBe("explicit-model");
  });

  test("folds fragmented UTF-8, late tool IDs and choice usage into the unchanged agent contract", async () => {
    const sent: Sent[] = [];
    const body =
      chunk({ reasoning_text: "想", content: "好", tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }) +
      chunk({ tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "1}" } }] }) +
      `data: ${jsonText({ choices: [{ delta: {}, finish_reason: "tool_calls", usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 20 } }] })}\n\n` +
      "data: [DONE]\n\n";
    const fragmented = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of new TextEncoder().encode(body)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const llm = llmOn(http(sent, fragmented));
    const message = await llm.complete(flash, context, { apiKey: "fixture" });
    expect(message.content).toEqual([
      { type: "thinking", thinking: "想", thinkingSignature: "reasoning_text" },
      { type: "text", text: "好" },
      { type: "toolCall", id: "call", name: "lookup", arguments: { x: 1 } },
    ]);
    expect(message.usage).toMatchObject({ input: 80, output: 5, cacheRead: 20, totalTokens: 105 });
    expect([message.stopReason, message.rawStopReason]).toEqual(["toolUse", "tool_calls"]);
    expect(sent).toHaveLength(1);
  });

  test("asks chat/completions with the key, and its stream comes back as pi-ai's events", async () => {
    const sent: Sent[] = [];
    const llm = llmOn(http(sent, answer));
    const events = await collect(llm.stream(flash, context, { apiKey: "k" }));
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "text_start",
      "text_delta",
      "text_delta",
      "thinking_end",
      "text_end",
      "done",
    ]);
    expect(sent).toEqual([{ url: "https://api.deepseek.com/chat/completions", authorization: "Bearer k", body: requestBody(flash, context, {}) }]);
    const last = events.at(-1)!;
    expect(last.type === "done" && last.message.content).toEqual([
      { type: "thinking", thinking: "想", thinkingSignature: "reasoning_content" },
      { type: "text", text: "你好" },
    ]);
  });

  test("a refusal is an LlmError with its status, and complete keeps it as the turn's error", async () => {
    const llm = llmOn(http([], jsonText({ error: { message: "Authentication Fails", type: "authentication_error" } }), 401));
    const failed = await failureOf(collect(llm.stream(flash, context, { apiKey: "bad" })));
    const said = '401: {"message":"Authentication Fails","type":"authentication_error"}';
    expect([failed.reason, failed.status, failed.message]).toEqual(["status", 401, said]);
    const kept = await llm.complete(flash, context, { apiKey: "bad" });
    expect([kept.stopReason, kept.errorMessage, kept.content]).toEqual(["error", said, []]);
  });

  test("a stream that breaks fails with what had come", async () => {
    const llm = llmOn(http([], chunk({ content: "半" }) + "data: {not json\n\n"));
    const failed = await failureOf(collect(llm.stream(flash, context, { apiKey: "k" })));
    expect(failed.reason).toBe("stream");
    expect(failed.partial?.content).toEqual([{ type: "text", text: "半" }]);
    const kept = await llm.complete(flash, context, { apiKey: "k" });
    expect([kept.stopReason, kept.content]).toEqual(["error", [{ type: "text", text: "半" }]]);
  });
});
