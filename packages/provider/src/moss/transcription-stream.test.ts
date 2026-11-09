import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { type MossTranscriptionEvent, streamMossTranscription } from "./transcription-stream.ts";

const input = { model: "moss-transcribe-diarize-pro", fileId: "file-one", diarize: true, keyterms: ["MOSS"] };
const task = { type: "task.created", task_id: "task-one", object: "audio.transcription", status: "PROCESSING", model: input.model };
const delta = { type: "transcript.text.delta", delta: "Welcome " };
const segment = {
  type: "transcript.segment.done",
  content_index: 0,
  speaker: "S01",
  start: 0.12,
  end: 3.98,
  text: "Welcome to MOSS.",
  session_usage: { prompt_tokens: 137, completion_tokens: 27, total_tokens: 164 },
};
const done = {
  type: "transcript.text.done",
  text: segment.text,
  usage: { type: "duration", prompt_tokens: 137, completion_tokens: 27, total_tokens: 164, input_audio_seconds: 4.08 },
  meta_info: { audio_duration_s: 4.08 },
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
const answer = (text: string, contentType = "text/event-stream") =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { headers: { "content-type": contentType } }))));
const collect = (text: string) =>
  streamMossTranscription("test-key", input).pipe(Stream.runCollect, Effect.provideService(HttpClient.HttpClient, answer(text)));

it.effect.each([1, 7, 65536])("diarization SSE survives %i-byte chunks and preserves text, segments and observed usage", (size) => {
  let calls = 0;
  const source = encoder.encode(
    `\uFEFF: heartbeat\r\n\r\n${[task, delta, { ...delta, delta: "MOSS \u00e9\ud83c\udf0d" }, segment, done].map(frame).join("").replaceAll("\n", "\r\n")}`,
  );
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
      expect(request.headers.authorization).toBe("Bearer test-key");
      expect(request.headers.accept).toBe("text/event-stream");
      expect(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).toMatchObject({ _tag: "Some", value: { redirect: "manual" } });
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        model: input.model,
        file_id: input.fileId,
        diarize: true,
        keyterms: input.keyterms,
        response_format: "verbose_json",
        stream: true,
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
    expect(yield* streamMossTranscription("test-key", input).pipe(Stream.runCollect)).toEqual([
      { type: task.type, taskId: task.task_id, model: input.model },
      { type: delta.type, text: delta.delta },
      { type: delta.type, text: "MOSS \u00e9\ud83c\udf0d" },
      {
        type: segment.type,
        index: 0,
        segment: { speaker: "S01", text: segment.text, start: 0.12, end: 3.98 },
        usage: { promptTokens: 137, completionTokens: 27, totalTokens: 164 },
      },
      { type: done.type, text: done.text, usage: { promptTokens: 137, completionTokens: 27, totalTokens: 164, inputAudioSeconds: 4.08 } },
    ]);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("named multiline frames do not require task metadata and absent counters stay absent", () =>
  Effect.gen(function* () {
    const events = yield* collect(
      `event: transcript.text.delta\rdata: {"type":"transcript.text.delta",\rdata: "delta":"partial"}\r\r${frame({ type: done.type, text: "final" })}`,
    );
    expect(events).toEqual([
      { type: delta.type, text: "partial" },
      { type: done.type, text: "final" },
    ]);
    expect(yield* collect(frame({ type: done.type, text: "" }))).toEqual([{ type: done.type, text: "" }]);
  }),
);

it.effect("text and segments arrive before the terminal response is available", () =>
  Effect.gen(function* () {
    const partial = yield* Deferred.make<void>();
    const events: MossTranscriptionEvent[] = [];
    let finish: (() => void) | undefined;
    const http = HttpClient.make((request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([task, delta, segment].map(frame).join("")));
          finish = () => {
            controller.enqueue(encoder.encode(frame(done)));
            controller.close();
          };
        },
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } })));
    });
    const fiber = yield* streamMossTranscription("test-key", input).pipe(
      Stream.tap((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(event.type === "transcript.segment.done" ? Deferred.succeed(partial, undefined) : Effect.void),
        ),
      ),
      Stream.runDrain,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.forkChild,
    );
    yield* Deferred.await(partial);
    expect(events.map((event) => event.type)).toEqual([task.type, delta.type, segment.type]);
    if (finish === undefined) return yield* Effect.die("Response body was not opened");
    finish();
    yield* Fiber.join(fiber);
    expect(events.at(-1)?.type).toBe(done.type);
  }),
);

it.effect.each([
  { text: "" },
  { text: frame(task) },
  { text: frame(delta) },
  { text: frame(delta) + frame(segment) },
  { text: frame(delta) + `data: ${JSON.stringify(done)}` },
  { text: frame(delta) + `data: ${JSON.stringify(done)}\n` },
  { text: frame(delta) + "data: [DONE]\n\n" },
  { text: frame(task) + frame(task) },
  { text: frame(delta) + frame(task) },
  { text: frame({ ...segment, end: -1 }) },
  { text: frame({ ...segment, start: 4, end: 3 }) },
  { text: frame({ ...segment, content_index: -1 }) },
  { text: frame({ ...segment, content_index: 0.5 }) },
  { text: frame({ ...segment, session_usage: { total_tokens: -1 } }) },
  { text: frame({ ...done, usage: { input_audio_seconds: -1 } }) },
  { text: frame({ type: delta.type, text: "wrong wire field" }) },
  { text: `event: transcript.text.done\n${frame(delta)}` },
  { text: "retry: 1000\n\n" },
])("malformed or truncated stream %# never claims success", ({ text }) =>
  Effect.gen(function* () {
    expect(yield* collect(text).pipe(Effect.flip)).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }),
);

it.effect("vendor failure preserves emitted partial results without exposing vendor diagnostics", () =>
  Effect.gen(function* () {
    const events: MossTranscriptionEvent[] = [];
    const error = yield* streamMossTranscription("test-key", input).pipe(
      Stream.tap((event) => Effect.sync(() => events.push(event))),
      Stream.runDrain,
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        answer([delta, segment, { type: "error", error: { code: "private-key", message: "signed-url" } }].map(frame).join("")),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([delta.type, segment.type]);
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(JSON.stringify(error)).not.toMatch(/private-key|signed-url/u);
  }),
);

it.effect.each([
  { model: "moss-transcribe-1.0", diarize: false, keyterms: [] },
  { model: "moss-transcribe-1.0-2026-07-22", diarize: false, keyterms: [] },
  { fileId: "../file" },
  { stream: true },
  { async: true },
  { url: "https://example.com/audio.wav" },
  { response_format: "text" },
])("unsupported streaming request %# is rejected before submission", (patch) =>
  Effect.gen(function* () {
    expect(yield* streamMossTranscription("test-key", { ...input, ...patch }).pipe(Stream.runDrain, Effect.flip)).toMatchObject({
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

it.effect.each(["", "private\nheader"])("invalid credential %# cannot reach the network", (key) =>
  Effect.gen(function* () {
    expect(yield* streamMossTranscription(key, input).pipe(Stream.runDrain, Effect.flip)).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect.each(
  [302, 400, 503].flatMap((status) => [
    { status, empty: false },
    { status, empty: true },
  ]),
)("regression: HTTP $status with empty=$empty cannot retry or redirect", ({ status, empty }) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    const headers = { location: "https://private.example.com" };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        empty ? new Response(null, { status, headers }) : Response.json({ error: { message: "private" } }, { status, headers }),
      ),
    );
  });
  return Effect.gen(function* () {
    const error = yield* streamMossTranscription("test-key", input).pipe(Stream.runDrain, Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: status === 400 ? "Rejected" : "Unknown" });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("JSON cannot masquerade as SSE", () =>
  Effect.gen(function* () {
    expect(yield* streamMossTranscription("test-key", input).pipe(Stream.runDrain, Effect.flip)).toMatchObject({
      reason: "InvalidResponse",
      outcome: "Unknown",
    });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(frame(done), "application/json"))),
);

it.effect.each([
  { text: `data: ${"x".repeat((4 << 20) + 1)}` },
  { text: frame({ ...delta, delta: "x".repeat(1 << 20) }) + frame(delta) },
  { text: frame({ ...segment, text: "x".repeat(1 << 20) }) + frame(segment) },
  { text: frame({ ...done, text: "x".repeat((1 << 20) + 1) }) },
])("event and cumulative text growth %# are bounded", ({ text }) =>
  Effect.gen(function* () {
    expect(yield* collect(text).pipe(Effect.flip)).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }),
);

it.effect.each(["done", "cancel", "timeout"])("%s closes a pending body without resubmitting", (action) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const events: MossTranscriptionEvent[] = [];
    let canceled = false;
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([delta, segment, ...(action === "done" ? [done] : [])].map(frame).join("")));
        },
        cancel() {
          canceled = true;
        },
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } })));
    });
    const fiber = yield* streamMossTranscription("test-key", input).pipe(
      Stream.tap((event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(event.type === "transcript.segment.done" ? Deferred.succeed(started, undefined) : Effect.void),
        ),
      ),
      Stream.runCollect,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else if (action === "timeout") {
      yield* TestClock.adjust("900 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    } else {
      expect((yield* Fiber.join(fiber).pipe(Effect.flip)).at(-1)?.type).toBe(done.type);
    }
    expect(events.map((event) => event.type)).toEqual([delta.type, segment.type, ...(action === "done" ? [done.type] : [])]);
    expect(canceled).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("the absolute deadline also interrupts waiting for headers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = false;
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      );
    });
    const fiber = yield* streamMossTranscription("test-key", input).pipe(
      Stream.runDrain,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("900 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(interrupted).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("the diarization snapshot preserves zero counters and does not invent omitted counters", () => {
  const model = "moss-transcribe-diarize-pro-2026-07-03";
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toMatchObject({ model, diarize: false, keyterms: [] });
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          [
            { ...task, model },
            { ...done, usage: { input_audio_seconds: 0, total_tokens: 0 } },
          ]
            .map(frame)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }),
  );
  return Effect.gen(function* () {
    const events = yield* streamMossTranscription("test-key", { ...input, model, diarize: false, keyterms: [] }).pipe(Stream.runCollect);
    expect(events.at(-1)).toEqual({ type: done.type, text: done.text, usage: { inputAudioSeconds: 0, totalTokens: 0 } });
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("EOF retains emitted text and segments but never produces a terminal event", () =>
  Effect.gen(function* () {
    const events: MossTranscriptionEvent[] = [];
    const error = yield* streamMossTranscription("test-key", input).pipe(
      Stream.tap((event) => Effect.sync(() => events.push(event))),
      Stream.runDrain,
      Effect.flip,
      Effect.provideService(HttpClient.HttpClient, answer([delta, segment].map(frame).join(""))),
    );
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(events.map((event) => event.type)).toEqual([delta.type, segment.type]);
  }),
);

it.effect("the wire response limit rejects an oversized chunk before SSE decoding", () => {
  const http = HttpClient.make((request) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array((32 << 20) + 1));
        controller.close();
      },
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } })));
  });
  return Effect.gen(function* () {
    expect(yield* streamMossTranscription("test-key", input).pipe(Stream.runDrain, Effect.flip)).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  { text: frame({ ...delta, delta: "" }).repeat(100001), count: 100000 },
  { text: frame({ ...segment, text: "" }).repeat(10001), count: 10000 },
])("regression: empty text cannot bypass event and segment count bound %#", ({ text, count }) => {
  let canceled = false;
  let emitted = 0;
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(text));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const error = yield* streamMossTranscription("test-key", input).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          emitted++;
        }),
      ),
      Stream.runDrain,
      Effect.flip,
    );
    expect(error).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
    expect(emitted).toBe(count);
    expect(canceled).toBe(true);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("regression: the 100000th event may finish the stream without inspecting later frames", () =>
  Effect.gen(function* () {
    const count = yield* streamMossTranscription("test-key", input).pipe(
      Stream.runCount,
      Effect.provideService(HttpClient.HttpClient, answer(frame({ ...delta, delta: "" }).repeat(99999) + frame(done) + frame({ type: "error" }))),
    );
    expect(count).toBe(100000);
  }),
);

it.effect("regression: a large SSE line survives many small chunks without accumulating transcript copies", () => {
  const text = "x".repeat(1 << 20);
  const source = encoder.encode(frame({ ...done, text }));
  let offset = 0;
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === source.length) controller.close();
              else {
                const end = Math.min(offset + 256, source.length);
                controller.enqueue(source.subarray(offset, end));
                offset = end;
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const events = yield* streamMossTranscription("test-key", input).pipe(Stream.runCollect);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: done.type, text });
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("regression: response headers and body share one absolute stream deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const headers = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    let canceled = false;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(headers);
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
        yield* Deferred.succeed(opened, undefined);
        return response;
      }),
    );
    const fiber = yield* streamMossTranscription("test-key", input).pipe(
      Stream.runDrain,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("899 seconds");
    yield* Deferred.succeed(headers, undefined);
    yield* Deferred.await(opened);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(canceled).toBe(true);
  }),
);
