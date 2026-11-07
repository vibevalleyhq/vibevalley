import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientError } from "effect/http";

import { complete, deepseek, MissingKey } from "./client.ts";
import { type LlmError, Llm, make } from "./llm.ts";
import type { Context } from "./messages.ts";
import { models } from "./models.ts";
import { requestBody } from "./request.ts";
import { chunk, http, type Sent } from "./testing.ts";

const flash = models[0];
const context: Context = { system: "你是管家。", tools: [], messages: [{ role: "user", content: "你好", timestamp: 1 }] };
const answer = chunk({ reasoning_content: "想" }) + chunk({ content: "你" }) + chunk({ content: "好" }) + chunk({}, "stop") + "data: [DONE]\n\n";

const llmOn = (layer: Layer.Layer<HttpClient.HttpClient>) => Layer.effect(Llm, make).pipe(Layer.provide(layer));

describe("Llm", () => {
  it.effect("keeps the original network cause and makes no retry or provider fallback", () => {
    let requests = 0;
    let original: HttpClientError.HttpClientError | undefined;
    const offline = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests++;
        original = new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "offline" }) });
        return Effect.fail(original);
      }),
    );
    return Effect.gen(function* () {
      const llm = yield* Llm;
      const error = yield* Effect.flip(Stream.runDrain(llm.stream(flash, context, { apiKey: "fixture" })));
      expect(error.reason).toBe("network");
      expect(error.message).toBe(`Connection error: ${original?.message}`);
      expect(error.cause).toBe(original);
      expect(error.partial).toBeUndefined();
      expect(requests).toBe(1);
    }).pipe(Effect.provide(llmOn(offline)));
  });

  it.effect("keeps the partial answer on a vendor stream error without retrying", () => {
    const sent: Sent[] = [];
    return Effect.gen(function* () {
      const llm = yield* Llm;
      const message = yield* llm.complete(flash, context, { apiKey: "fixture" });
      expect(message.content).toEqual([{ type: "text", text: "partial" }]);
      expect([message.stopReason, message.errorMessage]).toEqual(["error", "fixture refusal"]);
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(llmOn(http(sent, chunk({ content: "partial" }) + 'data: {"error":{"message":"fixture refusal"}}\n\n'))));
  });

  it.effect("cancels the response reader when the consumer stops after a text delta", () => {
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
    return Effect.gen(function* () {
      const llm = yield* Llm;
      const events = yield* llm.stream(flash, context, { apiKey: "fixture" }).pipe(Stream.take(3), Stream.runCollect);
      expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta"]);
      expect(sent).toHaveLength(1);
      expect(cancelled).toBe(1);
    }).pipe(Effect.provide(llmOn(http(sent, body))));
  });

  it.effect("reads a replaced caller key for each request and preserves explicit unknown model IDs", () => {
    const sent: Sent[] = [];
    return Effect.gen(function* () {
      const llm = yield* Llm;
      let key = "first";
      expect(() => deepseek("", "", llm)).toThrow(MissingKey);
      const client = deepseek("explicit-model", () => key, llm);
      yield* complete(client, context);
      key = "second";
      yield* complete(client, context);
      expect(sent.map((request) => request.authorization)).toEqual(["Bearer first", "Bearer second"]);
      expect(sent.map((request) => request.body)).toEqual([requestBody(client.model, context), requestBody(client.model, context)]);
      expect(client.model.id).toBe("explicit-model");
    }).pipe(Effect.provide(llmOn(http(sent, answer))));
  });

  it.effect("folds fragmented UTF-8, late tool IDs and choice usage into the unchanged agent contract", () => {
    const sent: Sent[] = [];
    const body =
      chunk({ reasoning_text: "想", content: "好", tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }) +
      chunk({ tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "1}" } }] }) +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls", usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 20 } }] })}\n\n` +
      "data: [DONE]\n\n";
    const fragmented = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of new TextEncoder().encode(body)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    return Effect.gen(function* () {
      const llm = yield* Llm;
      const message = yield* llm.complete(flash, context, { apiKey: "fixture" });
      expect(message.content).toEqual([
        { type: "thinking", thinking: "想", thinkingSignature: "reasoning_text" },
        { type: "text", text: "好" },
        { type: "toolCall", id: "call", name: "lookup", arguments: { x: 1 } },
      ]);
      expect(message.usage).toMatchObject({ input: 80, output: 5, cacheRead: 20, totalTokens: 105 });
      expect([message.stopReason, message.rawStopReason]).toEqual(["toolUse", "tool_calls"]);
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(llmOn(http(sent, fragmented))));
  });

  it.effect("asks chat/completions with the key, and its stream comes back as pi-ai's events", () => {
    const sent: Sent[] = [];
    return Effect.gen(function* () {
      const llm = yield* Llm;
      const events = yield* Stream.runCollect(llm.stream(flash, context, { apiKey: "k" }));
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
    }).pipe(Effect.provide(llmOn(http(sent, answer))));
  });

  it.effect("a refusal is an LlmError with its status, and complete keeps it as the turn's error", () =>
    Effect.gen(function* () {
      const llm = yield* Llm;
      const failed = yield* Effect.flip(Stream.runDrain(llm.stream(flash, context, { apiKey: "bad" })));
      const said = '401: {"message":"Authentication Fails","type":"authentication_error"}';
      expect([failed.reason, failed.status, failed.message]).toEqual(["status", 401, said]);
      const kept = yield* llm.complete(flash, context, { apiKey: "bad" });
      expect([kept.stopReason, kept.errorMessage, kept.content]).toEqual(["error", said, []]);
    }).pipe(Effect.provide(llmOn(http([], JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }), 401)))),
  );

  it.effect("a stream that breaks fails with what had come", () =>
    Effect.gen(function* () {
      const llm = yield* Llm;
      const failed: LlmError = yield* Effect.flip(Stream.runDrain(llm.stream(flash, context, { apiKey: "k" })));
      expect(failed.reason).toBe("stream");
      expect(failed.partial?.content).toEqual([{ type: "text", text: "半" }]);
      const kept = yield* llm.complete(flash, context, { apiKey: "k" });
      expect([kept.stopReason, kept.content]).toEqual(["error", [{ type: "text", text: "半" }]]);
    }).pipe(Effect.provide(llmOn(http([], chunk({ content: "半" }) + "data: {not json\n\n")))),
  );
});
