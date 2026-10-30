import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { HttpClient } from "effect/http";

import { type LlmError, Llm, make } from "./llm.ts";
import type { Context } from "./messages.ts";
import { models } from "./models.ts";
import { requestBody } from "./request.ts";
import { chunk, http, type Sent } from "./testing.ts";

const flash = models[0]!;
const context: Context = { system: "你是管家。", tools: [], messages: [{ role: "user", content: "你好", timestamp: 1 }] };
const answer = chunk({ reasoning_content: "想" }) + chunk({ content: "你" }) + chunk({ content: "好" }) + chunk({}, "stop") + "data: [DONE]\n\n";

const llmOn = (layer: Layer.Layer<HttpClient.HttpClient>) => Layer.effect(Llm, make).pipe(Layer.provide(layer));

describe("Llm", () => {
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
