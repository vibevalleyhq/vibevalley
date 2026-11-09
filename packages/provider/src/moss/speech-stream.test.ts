import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { Base64 } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { type MossSpeechEvent, streamMossSpeech } from "./speech-stream.ts";

const input = { model: "moss-tts-1.5-flash", text: "Synthetic sample", voice: "voice-one", format: "pcm" };
const task = { type: "task.created", task_id: "task-one", object: "audio.speech", status: "PROCESSING", model: input.model };
const created = { type: "speech.created", format: "pcm", sample_rate: 48000, channels: 1, bit_depth: 16, usage: { prompt_tokens: 7, total_tokens: 7 } };
const bytes = new Uint8Array([0, 0, 1, 0]);
const delta = { type: "speech.audio.delta", audio: Base64.encode(bytes), usage: { completion_tokens: 1, total_tokens: 1 } };
const done = {
  type: "speech.audio.done",
  usage: { input_characters: 11, prompt_tokens: 7, completion_tokens: 54, total_tokens: 61 },
  meta_info: { performance: { audio_duration_s: 2.16 } },
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
const answer = (text: string, contentType = "text/event-stream") =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { headers: { "content-type": contentType } }))));
const collect = (text: string) => streamMossSpeech("test-key", input).pipe(Stream.runCollect, Effect.provideService(HttpClient.HttpClient, answer(text)));

it.effect.each([1, 7, 65536])("observed Flash SSE survives %i-byte chunks and preserves metadata, PCM order and final usage", (size) => {
  let calls = 0;
  const source = encoder.encode(
    `\uFEFF: heartbeat\r\n\r\n${[task, created, delta, { ...delta, audio: Base64.encode(new Uint8Array([2, 0])) }, done].map(frame).join("").replaceAll("\n", "\r\n")}`,
  );
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers.accept).toBe("text/event-stream");
      expect(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).toMatchObject({ _tag: "Some", value: { redirect: "manual" } });
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        model: input.model,
        input: input.text,
        voice_id: input.voice,
        response_format: "pcm",
        stream: true,
        stream_format: "sse",
        async: false,
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < source.length; offset += size) controller.enqueue(source.subarray(offset, offset + size));
          controller.close();
        },
      });
      return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }));
    }),
  );
  return Effect.gen(function* () {
    const events = yield* streamMossSpeech("test-key", input).pipe(Stream.runCollect);
    expect(events).toEqual([
      { type: "task.created", taskId: "task-one", model: input.model },
      { type: "speech.created", format: "pcm", sampleRate: 48000, channels: 1, bitDepth: 16, usage: { promptTokens: 7, totalTokens: 7 } },
      { type: "speech.audio.delta", audio: bytes, usage: { completionTokens: 1, totalTokens: 1 } },
      { type: "speech.audio.delta", audio: new Uint8Array([2, 0]), usage: { completionTokens: 1, totalTokens: 1 } },
      { type: "speech.audio.done", usage: { inputCharacters: 11, promptTokens: 7, completionTokens: 54, totalTokens: 61 }, durationSeconds: 2.16 },
    ]);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("multiline SSE data and named events are decoded without requiring task.created", () =>
  Effect.gen(function* () {
    const text = `event: speech.created\rdata: {"type":"speech.created",\rdata: "format":"pcm","sample_rate":24000,"channels":2,"bit_depth":16}\r\r${frame({ type: delta.type, audio: delta.audio })}${frame({ type: done.type })}`;
    const events = yield* collect(text);
    expect(events).toEqual([
      { type: "speech.created", format: "pcm", sampleRate: 24000, channels: 2, bitDepth: 16 },
      { type: "speech.audio.delta", audio: bytes },
      { type: "speech.audio.done" },
    ]);
  }),
);

it.effect("PCM samples may span delta boundaries, but the completed stream must align", () =>
  Effect.gen(function* () {
    const events = yield* collect([created, { type: delta.type, audio: "AQ==" }, { type: delta.type, audio: "AA==" }, done].map(frame).join(""));
    expect(events.map((event) => event.type)).toEqual(["speech.created", "speech.audio.delta", "speech.audio.delta", "speech.audio.done"]);
    expect(yield* collect([created, { type: delta.type, audio: "AQ==" }, done].map(frame).join("")).pipe(Effect.flip)).toMatchObject({
      reason: "InvalidResponse",
      outcome: "Unknown",
    });
  }),
);

it.effect.each([
  { text: "" },
  { text: frame(task) },
  { text: frame(created) },
  { text: frame(created) + frame(delta) },
  { text: frame(created) + frame(delta) + `data: ${JSON.stringify(done)}` },
  { text: frame(created) + frame(delta) + "data: [DONE]\n\n" },
  { text: frame(delta) + frame(done) },
  { text: frame(done) },
  { text: frame(created) + frame(created) + frame(delta) + frame(done) },
  { text: frame(task) + frame(task) + frame(created) + frame(delta) + frame(done) },
  { text: frame(created) + frame(task) + frame(delta) + frame(done) },
  { text: frame(created) + frame({ ...delta, audio: "@@@@" }) + frame(done) },
  { text: frame(created) + frame({ ...delta, audio: "" }) + frame(done) },
  { text: frame({ type: "speech.created", format: "pcm", channels: 1, bit_depth: 16 }) + frame(delta) + frame(done) },
  { text: frame({ ...created, sample_rate: 0 }) + frame(delta) + frame(done) },
  { text: frame({ ...created, channels: 0 }) + frame(delta) + frame(done) },
  { text: frame({ ...created, format: "mp3" }) + frame(delta) + frame(done) },
  { text: frame({ ...created, usage: { total_tokens: -1 } }) + frame(delta) + frame(done) },
  { text: frame(created) + frame(delta) + frame({ ...done, meta_info: { performance: { audio_duration_s: -1 } } }) },
  { text: `event: speech.audio.done\n${frame(created)}` },
  { text: "retry: 1000\n\n" },
])("invalid or incomplete SSE %# never claims completion", ({ text }) =>
  Effect.gen(function* () {
    expect(yield* collect(text).pipe(Effect.flip)).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }),
);

it.effect("a vendor stream error preserves already emitted audio but never leaks its diagnostics", () =>
  Effect.gen(function* () {
    const events: MossSpeechEvent[] = [];
    const error = yield* streamMossSpeech("test-key", input).pipe(
      Stream.tap((event) => Effect.sync(() => events.push(event))),
      Stream.runDrain,
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        answer([created, delta, { type: "error", error: { code: "private-key", message: "signed-url" } }].map(frame).join("")),
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["speech.created", "speech.audio.delta"]);
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(JSON.stringify(error)).not.toMatch(/private-key|signed-url/u);
  }),
);

it.effect.each([
  { model: "moss-tts-1.0-pro" },
  { model: "moss-tts-1.0-pro-2026-02-07" },
  { format: "wav" },
  { stream: true },
  { delivery_method: "url" },
  { webhook_url: "https://example.com" },
])("unsupported streaming request %# is rejected before submission", (patch) =>
  Effect.gen(function* () {
    expect(yield* streamMossSpeech("test-key", { ...input, ...patch }).pipe(Stream.runDrain, Effect.flip)).toMatchObject({
      reason: "InvalidInput",
      outcome: "NotSubmitted",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect.each(["", "private\nheader"])("invalid streaming credential %# is not submitted", (key) =>
  Effect.gen(function* () {
    expect(yield* streamMossSpeech(key, input).pipe(Stream.runDrain, Effect.flip)).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect.each([302, 400, 503])("HTTP %i does not retry or follow redirects", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ error: { code: "private", message: "secret" } }, { status, headers: { location: "https://private.example.com" } }),
      ),
    );
  });
  return Effect.gen(function* () {
    const error = yield* streamMossSpeech("test-key", input).pipe(Stream.runDrain, Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: status === 400 ? "Rejected" : "Unknown" });
    expect(JSON.stringify(error)).not.toMatch(/private|secret/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("a successful JSON or raw PCM response cannot masquerade as an SSE stream", () =>
  Effect.gen(function* () {
    expect(yield* streamMossSpeech("test-key", input).pipe(Stream.runDrain, Effect.flip)).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(frame(created), "audio/pcm"))),
);

it.effect.each([
  { text: `data: ${"x".repeat((1 << 20) + 1)}` },
  { text: frame(created) + frame({ ...delta, audio: Base64.encode(new Uint8Array((512 << 10) + 1)) }) },
])("oversized pending event or decoded audio frame %# is bounded", ({ text }) =>
  Effect.gen(function* () {
    expect(yield* collect(text).pipe(Effect.flip)).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }),
);

it.effect.each(["done", "cancel", "timeout"])("%s closes the response body without another submission", (action) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let canceled = false;
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([created, delta, ...(action === "done" ? [done] : [])].map(frame).join("")));
        },
        cancel() {
          canceled = true;
        },
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } })));
    });
    const fiber = yield* streamMossSpeech("test-key", input).pipe(
      Stream.tap((event) => (event.type === "speech.audio.delta" ? Deferred.succeed(started, undefined) : Effect.void)),
      Stream.runCollect,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else if (action === "timeout") {
      yield* TestClock.adjust("300 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    } else {
      const events = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(events.at(-1)?.type).toBe("speech.audio.done");
    }
    expect(canceled).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("the absolute deadline includes waiting for response headers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    const fiber = yield* streamMossSpeech("test-key", input).pipe(
      Stream.runDrain,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(calls).toBe(1);
  }),
);

it.effect("Flash snapshot requests preserve explicit optional controls and zero usage", () => {
  const snapshot = "moss-tts-1.5-flash-2026-06-26";
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject({
        model: snapshot,
        language: "English",
        expected_duration_sec: 2,
        aigc_metadata: { enabled: false },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          [
            { ...task, model: snapshot },
            { ...created, usage: { prompt_tokens: 0 } },
            delta,
            { type: done.type, usage: { completion_tokens: 0 }, meta_info: { performance: { audio_duration_s: 0 } } },
          ]
            .map(frame)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const events = yield* streamMossSpeech("test-key", {
      ...input,
      model: snapshot,
      language: "English",
      expectedDuration: 2,
      metadata: { enabled: false },
    }).pipe(Stream.runCollect);
    expect(events[1]).toHaveProperty("usage", { promptTokens: 0 });
    expect(events.at(-1)).toEqual({ type: "speech.audio.done", usage: { completionTokens: 0 }, durationSeconds: 0 });
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});
