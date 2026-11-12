import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { collect as collectAll } from "@vibevalley/async";

import { answering, failure, json, shown, unreachable } from "../base/testing.ts";
import { type MossSpeechEvent, streamMossSpeech } from "./speech-stream.ts";

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const input = { model: "moss-tts-1.5-flash", text: "Synthetic sample", voice: "voice-one", format: "pcm" };
const task = { type: "task.created", task_id: "task-one", object: "audio.speech", status: "PROCESSING", model: input.model };
const created = { type: "speech.created", format: "pcm", sample_rate: 48000, channels: 1, bit_depth: 16, usage: { prompt_tokens: 7, total_tokens: 7 } };
const bytes = new Uint8Array([0, 0, 1, 0]);
const delta = { type: "speech.audio.delta", audio: base64(bytes), usage: { completion_tokens: 1, total_tokens: 1 } };
const done = {
  type: "speech.audio.done",
  usage: { input_characters: 11, prompt_tokens: 7, completion_tokens: 54, total_tokens: 61 },
  meta_info: { performance: { audio_duration_s: 2.16 } },
};
const frame = (value: unknown) => `data: ${json(value)}\n\n`;
const encoder = new TextEncoder();
const answer = (text: string, contentType = "text/event-stream") => ({
  fetch: answering(() => new Response(text, { headers: { "content-type": contentType } })),
});
const collect = (text: string) => collectAll(streamMossSpeech("test-key", input, answer(text)));

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for([1, 7, 65536])("observed Flash SSE survives %i-byte chunks and preserves metadata, PCM order and final usage", async (size) => {
  let calls = 0;
  const source = encoder.encode(
    `﻿: heartbeat\r\n\r\n${[task, created, delta, { ...delta, audio: base64(new Uint8Array([2, 0])) }, done].map(frame).join("").replaceAll("\n", "\r\n")}`,
  );
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
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
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  });
  const events = await collectAll(streamMossSpeech("test-key", input, { fetch }));
  expect(events).toEqual([
    { type: "task.created", taskId: "task-one", model: input.model },
    { type: "speech.created", format: "pcm", sampleRate: 48000, channels: 1, bitDepth: 16, usage: { promptTokens: 7, totalTokens: 7 } },
    { type: "speech.audio.delta", audio: bytes, usage: { completionTokens: 1, totalTokens: 1 } },
    { type: "speech.audio.delta", audio: new Uint8Array([2, 0]), usage: { completionTokens: 1, totalTokens: 1 } },
    { type: "speech.audio.done", usage: { inputCharacters: 11, promptTokens: 7, completionTokens: 54, totalTokens: 61 }, durationSeconds: 2.16 },
  ]);
  expect(calls).toBe(1);
});

it("multiline SSE data and named events are decoded without requiring task.created", async () => {
  const text = `event: speech.created\rdata: {"type":"speech.created",\rdata: "format":"pcm","sample_rate":24000,"channels":2,"bit_depth":16}\r\r${frame({ type: delta.type, audio: delta.audio })}${frame({ type: done.type })}`;
  const events = await collect(text);
  expect(events).toEqual([
    { type: "speech.created", format: "pcm", sampleRate: 24000, channels: 2, bitDepth: 16 },
    { type: "speech.audio.delta", audio: bytes },
    { type: "speech.audio.done" },
  ]);
});

it("PCM samples may span delta boundaries, but the completed stream must align", async () => {
  const events = await collect([created, { type: delta.type, audio: "AQ==" }, { type: delta.type, audio: "AA==" }, done].map(frame).join(""));
  expect(events.map((event) => event.type)).toEqual(["speech.created", "speech.audio.delta", "speech.audio.delta", "speech.audio.done"]);
  const collectedFailure = await failure(collect([created, { type: delta.type, audio: "AQ==" }, done].map(frame).join("")));
  expect(collectedFailure).toMatchObject({
    reason: "InvalidResponse",
    outcome: "Unknown",
  });
});

it.for([
  { text: "" },
  { text: frame(task) },
  { text: frame(created) },
  { text: frame(created) + frame(delta) },
  { text: frame(created) + frame(delta) + `data: ${json(done)}` },
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
])("invalid or incomplete SSE %# never claims completion", async ({ text }) => {
  const collectedFailure = await failure(collect(text));
  expect(collectedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it("a vendor stream error preserves already emitted audio but never leaks its diagnostics", async () => {
  const events: MossSpeechEvent[] = [];
  const error = await failure(
    (async () => {
      for await (const event of streamMossSpeech(
        "test-key",
        input,
        answer([created, delta, { type: "error", error: { code: "private-key", message: "signed-url" } }].map(frame).join("")),
      ))
        events.push(event);
    })(),
  );
  expect(events.map((event) => event.type)).toEqual(["speech.created", "speech.audio.delta"]);
  expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/private-key|signed-url/u);
});

it.for([
  { model: "moss-tts-1.0-pro" },
  { model: "moss-tts-1.0-pro-2026-02-07" },
  { format: "wav" },
  { stream: true },
  { delivery_method: "url" },
  { webhook_url: "https://example.com" },
])("unsupported streaming request %# is rejected before submission", async (patch) => {
  const streamMossSpeechFailure = await failure(collectAll(streamMossSpeech("test-key", { ...input, ...patch }, { fetch: unreachable })));
  expect(streamMossSpeechFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});

it.for(["", "private\nheader"])("invalid streaming credential %# is not submitted", async (key) => {
  const streamMossSpeechFailure = await failure(collectAll(streamMossSpeech(key, input, { fetch: unreachable })));
  expect(streamMossSpeechFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it.for([302, 400, 503])("HTTP %i does not retry or follow redirects", async (status) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return Response.json({ error: { code: "private", message: "secret" } }, { status, headers: { location: "https://private.example.com" } });
  });
  const error = await failure(collectAll(streamMossSpeech("test-key", input, { fetch })));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: status === 400 ? "Rejected" : "Unknown" });
  expect(shown(error)).not.toMatch(/private|secret/u);
  expect(calls).toBe(1);
});

it("a successful JSON or raw PCM response cannot masquerade as an SSE stream", async () => {
  const streamMossSpeechFailure = await failure(collectAll(streamMossSpeech("test-key", input, answer(frame(created), "audio/pcm"))));
  expect(streamMossSpeechFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it.for([{ text: `data: ${"x".repeat((1 << 20) + 1)}` }, { text: frame(created) + frame({ ...delta, audio: base64(new Uint8Array((512 << 10) + 1)) }) }])(
  "oversized pending event or decoded audio frame %# is bounded",
  async ({ text }) => {
    const collectedFailure = await failure(collect(text));
    expect(collectedFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  },
);

it.for(["done", "cancel", "timeout"])("%s closes the response body without another submission", async (action) => {
  const started = Promise.withResolvers<void>();
  let canceled = false;
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([created, delta, ...(action === "done" ? [done] : [])].map(frame).join("")));
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const stop = new AbortController();
  const events: MossSpeechEvent[] = [];
  const run = (async () => {
    for await (const event of streamMossSpeech("test-key", input, { fetch, signal: stop.signal })) {
      events.push(event);
      if (event.type === "speech.audio.delta") started.resolve();
    }
  })();
  const result = run.then(
    () => undefined,
    (e: unknown) => e,
  );
  await started.promise;
  if (action === "cancel") {
    stop.abort();
    await result;
  } else if (action === "timeout") {
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  } else {
    expect(await result).toBeUndefined();
    expect(events.at(-1)?.type).toBe("speech.audio.done");
  }
  expect(canceled).toBe(true);
  expect(calls).toBe(1);
});

it("the absolute deadline includes waiting for response headers", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const fetcher: typeof globalThis.fetch = () => {
    calls++;
    started.resolve();
    return new Promise<Response>(() => undefined);
  };
  const result = failure(collectAll(streamMossSpeech("test-key", input, { fetch: fetcher })));
  await started.promise;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(calls).toBe(1);
});

it("Flash snapshot requests preserve explicit optional controls and zero usage", async () => {
  const snapshot = "moss-tts-1.5-flash-2026-06-26";
  const fetch = answering(async (request) => {
    expect(await request.json()).toMatchObject({
      model: snapshot,
      language: "English",
      expected_duration_sec: 2,
      aigc_metadata: { enabled: false },
    });
    return new Response(
      [
        { ...task, model: snapshot },
        { ...created, usage: { prompt_tokens: 0 } },
        delta,
        { type: done.type, usage: { completion_tokens: 0 }, meta_info: { performance: { audio_duration_s: 0 } } },
      ]
        .map(frame)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const events = await collectAll(
    streamMossSpeech(
      "test-key",
      {
        ...input,
        model: snapshot,
        language: "English",
        expectedDuration: 2,
        metadata: { enabled: false },
      },
      { fetch },
    ),
  );
  expect(events[1]).toHaveProperty("usage", { promptTokens: 0 });
  expect(events.at(-1)).toEqual({ type: "speech.audio.done", usage: { completionTokens: 0 }, durationSeconds: 0 });
});
