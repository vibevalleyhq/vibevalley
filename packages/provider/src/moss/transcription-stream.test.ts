import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { collect as collectAll } from "@vibevalley/async";

import { answering, failure, json, shown, unreachable } from "../base/testing.ts";
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
const frame = (value: unknown) => `data: ${json(value)}\n\n`;
const encoder = new TextEncoder();
const answer = (text: string, contentType = "text/event-stream") => ({
  fetch: answering(() => new Response(text, { headers: { "content-type": contentType } })),
});
const collect = (text: string) => collectAll(streamMossTranscription("test-key", input, answer(text)));
/** Every event into onEvent; resolves when the stream ends. */
const drain = async (events: AsyncIterable<MossTranscriptionEvent>, onEvent: (event: MossTranscriptionEvent) => void = () => {}) => {
  for await (const event of events) onEvent(event);
};

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for([1, 7, 65536])("diarization SSE survives %i-byte chunks and preserves text, segments and observed usage", async (size) => {
  let calls = 0;
  const source = encoder.encode(
    `﻿: heartbeat\r\n\r\n${[task, delta, { ...delta, delta: "MOSS é🌍" }, segment, done].map(frame).join("").replaceAll("\n", "\r\n")}`,
  );
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
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
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  });
  const streamMossTranscription2 = await collectAll(streamMossTranscription("test-key", input, { fetch }));
  expect(streamMossTranscription2).toEqual([
    { type: task.type, taskId: task.task_id, model: input.model },
    { type: delta.type, text: delta.delta },
    { type: delta.type, text: "MOSS é🌍" },
    {
      type: segment.type,
      index: 0,
      segment: { speaker: "S01", text: segment.text, start: 0.12, end: 3.98 },
      usage: { promptTokens: 137, completionTokens: 27, totalTokens: 164 },
    },
    { type: done.type, text: done.text, usage: { promptTokens: 137, completionTokens: 27, totalTokens: 164, inputAudioSeconds: 4.08 } },
  ]);
  expect(calls).toBe(1);
});

it("named multiline frames do not require task metadata and absent counters stay absent", async () => {
  const events = await collect(
    `event: transcript.text.delta\rdata: {"type":"transcript.text.delta",\rdata: "delta":"partial"}\r\r${frame({ type: done.type, text: "final" })}`,
  );
  expect(events).toEqual([
    { type: delta.type, text: "partial" },
    { type: done.type, text: "final" },
  ]);
  const collected = await collect(frame({ type: done.type, text: "" }));
  expect(collected).toEqual([{ type: done.type, text: "" }]);
});

it("text and segments arrive before the terminal response is available", async () => {
  const partial = Promise.withResolvers<void>();
  const events: MossTranscriptionEvent[] = [];
  let finish: (() => void) | undefined;
  const fetch = answering(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([task, delta, segment].map(frame).join("")));
        finish = () => {
          controller.enqueue(encoder.encode(frame(done)));
          controller.close();
        };
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const run = drain(streamMossTranscription("test-key", input, { fetch }), (event) => {
    events.push(event);
    if (event.type === "transcript.segment.done") partial.resolve();
  });
  await partial.promise;
  expect(events.map((event) => event.type)).toEqual([task.type, delta.type, segment.type]);
  if (finish === undefined) throw new Error("Response body was not opened");
  finish();
  await run;
  expect(events.at(-1)?.type).toBe(done.type);
});

it.for([
  { text: "" },
  { text: frame(task) },
  { text: frame(delta) },
  { text: frame(delta) + frame(segment) },
  { text: frame(delta) + `data: ${json(done)}` },
  { text: frame(delta) + `data: ${json(done)}\n` },
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
])("malformed or truncated stream %# never claims success", async ({ text }) => {
  const collectedFailure = await failure(collect(text));
  expect(collectedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it("vendor failure preserves emitted partial results without exposing vendor diagnostics", async () => {
  const events: MossTranscriptionEvent[] = [];
  const error = await failure(
    drain(
      streamMossTranscription(
        "test-key",
        input,
        answer([delta, segment, { type: "error", error: { code: "private-key", message: "signed-url" } }].map(frame).join("")),
      ),
      (event) => events.push(event),
    ),
  );
  expect(events.map((event) => event.type)).toEqual([delta.type, segment.type]);
  expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/private-key|signed-url/u);
});

it.for([
  { model: "moss-transcribe-1.0", diarize: false, keyterms: [] },
  { model: "moss-transcribe-1.0-2026-07-22", diarize: false, keyterms: [] },
  { fileId: "../file" },
  { stream: true },
  { async: true },
  { url: "https://example.com/audio.wav" },
  { response_format: "text" },
])("unsupported streaming request %# is rejected before submission", async (patch) => {
  const streamMossTranscriptionFailure = await failure(drain(streamMossTranscription("test-key", { ...input, ...patch }, { fetch: unreachable })));
  expect(streamMossTranscriptionFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});

it.for(["", "private\nheader"])("invalid credential %# cannot reach the network", async (key) => {
  const streamMossTranscriptionFailure = await failure(drain(streamMossTranscription(key, input, { fetch: unreachable })));
  expect(streamMossTranscriptionFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it.for(
  [302, 400, 503].flatMap((status) => [
    { status, empty: false },
    { status, empty: true },
  ]),
)("regression: HTTP $status with empty=$empty cannot retry or redirect", async ({ status, empty }) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    const headers = { location: "https://private.example.com" };
    return empty ? new Response(null, { status, headers }) : Response.json({ error: { message: "private" } }, { status, headers });
  });
  const error = await failure(drain(streamMossTranscription("test-key", input, { fetch })));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: status === 400 ? "Rejected" : "Unknown" });
  expect(shown(error)).not.toContain("private");
  expect(calls).toBe(1);
});

it("JSON cannot masquerade as SSE", async () => {
  const streamMossTranscriptionFailure = await failure(drain(streamMossTranscription("test-key", input, answer(frame(done), "application/json"))));
  expect(streamMossTranscriptionFailure).toMatchObject({
    reason: "InvalidResponse",
    outcome: "Unknown",
  });
});

it.for([
  { text: `data: ${"x".repeat((4 << 20) + 1)}` },
  { text: frame({ ...delta, delta: "x".repeat(1 << 20) }) + frame(delta) },
  { text: frame({ ...segment, text: "x".repeat(1 << 20) }) + frame(segment) },
  { text: frame({ ...done, text: "x".repeat((1 << 20) + 1) }) },
])("event and cumulative text growth %# are bounded", async ({ text }) => {
  const collectedFailure = await failure(collect(text));
  expect(collectedFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it.for(["done", "cancel", "timeout"])("%s closes a pending body without resubmitting", async (action) => {
  const started = Promise.withResolvers<void>();
  const events: MossTranscriptionEvent[] = [];
  let canceled = false;
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([delta, segment, ...(action === "done" ? [done] : [])].map(frame).join("")));
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const stop = new AbortController();
  const result = drain(streamMossTranscription("test-key", input, { fetch, signal: stop.signal }), (event) => {
    events.push(event);
    if (event.type === "transcript.segment.done") started.resolve();
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  await started.promise;
  if (action === "cancel") {
    stop.abort();
    await result;
  } else if (action === "timeout") {
    await vi.advanceTimersByTimeAsync(900_000);
    expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  } else {
    expect(await result).toBeUndefined();
    expect(events.at(-1)?.type).toBe(done.type);
  }
  expect(events.map((event) => event.type)).toEqual([delta.type, segment.type, ...(action === "done" ? [done.type] : [])]);
  expect(canceled).toBe(true);
  expect(calls).toBe(1);
});

it("the absolute deadline also interrupts waiting for headers", async () => {
  const started = Promise.withResolvers<void>();
  let interrupted = false;
  let calls = 0;
  const fetcher: typeof globalThis.fetch = (_input, init) => {
    calls++;
    started.resolve();
    init?.signal?.addEventListener("abort", () => {
      interrupted = true;
    });
    return new Promise<Response>(() => undefined);
  };
  const result = failure(drain(streamMossTranscription("test-key", input, { fetch: fetcher })));
  await started.promise;
  await vi.advanceTimersByTimeAsync(900_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(interrupted).toBe(true);
  expect(calls).toBe(1);
});

it("the diarization snapshot preserves zero counters and does not invent omitted counters", async () => {
  const model = "moss-transcribe-diarize-pro-2026-07-03";
  const fetch = answering(async (request) => {
    expect(await request.json()).toMatchObject({ model, diarize: false, keyterms: [] });
    return new Response(
      [
        { ...task, model },
        { ...done, usage: { input_audio_seconds: 0, total_tokens: 0 } },
      ]
        .map(frame)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const events = await collectAll(streamMossTranscription("test-key", { ...input, model, diarize: false, keyterms: [] }, { fetch }));
  expect(events.at(-1)).toEqual({ type: done.type, text: done.text, usage: { inputAudioSeconds: 0, totalTokens: 0 } });
});

it("EOF retains emitted text and segments but never produces a terminal event", async () => {
  const events: MossTranscriptionEvent[] = [];
  const error = await failure(drain(streamMossTranscription("test-key", input, answer([delta, segment].map(frame).join(""))), (event) => events.push(event)));
  expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  expect(events.map((event) => event.type)).toEqual([delta.type, segment.type]);
});

it("the wire response limit rejects an oversized chunk before SSE decoding", async () => {
  const fetch = answering(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array((32 << 20) + 1));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const streamMossTranscriptionFailure = await failure(drain(streamMossTranscription("test-key", input, { fetch })));
  expect(streamMossTranscriptionFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it.for([
  { text: frame({ ...delta, delta: "" }).repeat(100001), count: 100000 },
  { text: frame({ ...segment, text: "" }).repeat(10001), count: 10000 },
])("regression: empty text cannot bypass event and segment count bound %#", async ({ text, count }) => {
  let canceled = false;
  let emitted = 0;
  const fetch = answering(
    () =>
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
  );
  const error = await failure(
    drain(streamMossTranscription("test-key", input, { fetch }), () => {
      emitted++;
    }),
  );
  expect(error).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  expect(emitted).toBe(count);
  expect(canceled).toBe(true);
});

it("regression: the 100000th event may finish the stream without inspecting later frames", async () => {
  const events = await collectAll(
    streamMossTranscription("test-key", input, answer(frame({ ...delta, delta: "" }).repeat(99999) + frame(done) + frame({ type: "error" }))),
  );
  expect(events.length).toBe(100000);
});

it("regression: a large SSE line survives many small chunks without accumulating transcript copies", async () => {
  const text = "x".repeat(1 << 20);
  const source = encoder.encode(frame({ ...done, text }));
  let offset = 0;
  const fetch = answering(
    () =>
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
  );
  const events = await collectAll(streamMossTranscription("test-key", input, { fetch }));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: done.type, text });
});

it("regression: response headers and body share one absolute stream deadline", async () => {
  const started = Promise.withResolvers<void>();
  const headers = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let canceled = false;
  const fetcher: typeof globalThis.fetch = async () => {
    started.resolve();
    await headers.promise;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    opened.resolve();
    return response;
  };
  const result = failure(drain(streamMossTranscription("test-key", input, { fetch: fetcher })));
  await started.promise;
  await vi.advanceTimersByTimeAsync(899_000);
  headers.resolve();
  await opened.promise;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(canceled).toBe(true);
});
