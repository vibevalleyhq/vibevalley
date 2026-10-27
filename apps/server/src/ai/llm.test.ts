import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { llmStreamFn } from "../agent/brain/config.ts";
import { type LlmError, Llm, make } from "./llm.ts";
import type { Context } from "./messages.ts";
import { models } from "./models.ts";
import { requestBody } from "./request.ts";

const flash = models[0]!;
const context: Context = { system: "你是管家。", tools: [], messages: [{ role: "user", content: "你好", timestamp: 1 }] };
const chunk = (delta: Record<string, unknown>, finish: string | null = null, more: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "r", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }], ...more })}\n\n`;
const answer = chunk({ reasoning_content: "想" }) + chunk({ content: "你" }) + chunk({ content: "好" }) + chunk({}, "stop") + "data: [DONE]\n\n";

interface Sent {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** A model answering every request with body (a string, or a stream it writes), at status. */
const http = (sent: Sent[], body: string | ReadableStream<Uint8Array>, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const b = request.body;
      sent.push({
        url: url.toString(),
        authorization: request.headers.authorization,
        body: b._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(b.body)) : undefined,
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
    }),
  );

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

describe("pi-agent-core's request on the Llm", () => {
  it("a request stopped by its signal ends aborted with what had come", async () => {
    let wrote = false;
    // One delta, then nothing more until the request is stopped.
    const hanging = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (wrote) return new Promise(() => {});
        wrote = true;
        controller.enqueue(new TextEncoder().encode(chunk({ content: "说到" })));
        return undefined;
      },
    });
    const llm = Effect.runSync(make.pipe(Effect.provide(http([], hanging))));
    const stream = llmStreamFn(llm, (effect, options) => Effect.runPromise(effect, options));
    const stop = new AbortController();
    const out = await stream(flash as never, { messages: [{ role: "system", content: "p", timestamp: 0 }, ...context.messages] } as never, {
      apiKey: "k",
      signal: stop.signal,
    });
    for await (const e of out)
      if (e.type === "text_delta") {
        stop.abort();
        break;
      }
    const ended = await out.result();
    expect([ended.stopReason, ended.errorMessage, ended.content]).toEqual(["aborted", "Request was aborted", [{ type: "text", text: "说到" }]]);
  });

  it("a failed request is pi-ai's error event, the system message read as the prompt", async () => {
    const sent: Sent[] = [];
    const llm = Effect.runSync(make.pipe(Effect.provide(http(sent, "nope", 500))));
    const stream = llmStreamFn(llm, (effect, options) => Effect.runPromise(effect, options));
    const out = await stream(flash as never, { messages: [{ role: "system", content: "提示", timestamp: 0 }, ...context.messages] } as never, { apiKey: "k" });
    const ended = await out.result();
    expect([ended.stopReason, ended.errorMessage]).toEqual(["error", "500 nope"]);
    expect((sent[0]!.body as { messages: unknown[] }).messages[0]).toEqual({ role: "system", content: "提示" });
  });
});
