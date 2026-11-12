import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, shown, unreachable } from "../base/testing.ts";
import { mossSpeechLanguages, mossSpeechModels } from "./speech-models.ts";
import { createMossSpeechTask, generateMossSpeech, prepareMossSpeech } from "./speech.ts";

const input = { model: "moss-tts-1.5-flash", text: "A synthetic speech sample.", voice: "voice-test", format: "mp3" };
const result = {
  id: "speech-one",
  object: "audio.speech",
  status: "SUCCESS",
  url: "https://audio.example.com/result.mp3?token=private",
  response_format: "mp3",
  content_type: "audio/mpeg",
  created_at: 1,
};
const answer = (body: unknown, status = 200) => ({ fetch: answering(() => Response.json(body, { status })) });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for(mossSpeechModels)("%s submits once with explicit credentials and URL delivery", async (model) => {
  let calls = 0;
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
      model,
      input: input.text,
      voice_id: input.voice,
      response_format: "mp3",
      delivery_method: "url",
      stream: false,
      async: false,
    });
    return Response.json(result);
  });
  const speech = await generateMossSpeech("test-key", { ...input, model }, { fetch });
  expect(speech).toEqual({ id: result.id, url: result.url, format: "mp3", contentType: "audio/mpeg", createdAt: 1 });
  expect(speech).not.toHaveProperty("usage");
  expect(calls).toBe(1);
});

it("Flash languages and pause controls are preserved with explicit false metadata", async () => {
  for (const language of mossSpeechLanguages) {
    const request = await prepareMossSpeech({
      ...input,
      language,
      text: "Hello [pause 0.1s] world [pause 10.0s]",
      expectedDuration: 1.5,
      metadata: { enabled: false, contentPropagator: "test", propagateId: "propagation-one" },
    });
    expect(request).toMatchObject({
      language,
      expected_duration_sec: 1.5,
      aigc_metadata: { enabled: false, content_propagator: "test", propagate_id: "propagation-one" },
    });
    expect(request.input).toContain("[pause 10.0s]");
  }
});

it.for([
  { model: "moss-ttsd-1.0" },
  { model: "moss-tts-1.0-pro", language: "English" },
  { model: "moss-tts-1.0-pro-2026-02-07", text: "Hello [pause 0.8s]" },
  { language: "en" },
  { language: "zh" },
  { voice: "" },
  { voice: "../private" },
  { voice_url: "https://example.com/voice.wav" },
  { voice_data: "base64" },
  { file_id: "file-one" },
  { sample_rate: 24000 },
  { stream: true },
  { async: true },
  { webhook_url: "https://example.com/callback" },
  { stream_format: "sse" },
  { delivery_method: "audio" },
  { text: "" },
  { text: "  " },
  { text: "x".repeat(10001) },
  { text: "Hello [pause 0.01s]" },
  { text: "Hello [pause 10.1s]" },
  { text: "Hello [pause invalid]" },
  { expectedDuration: 0 },
  { expectedDuration: Infinity },
  { expectedDuration: 3601 },
  { format: "ogg" },
  { metadata: { enabled: "yes" } },
])("unsupported or invalid speech input %# never reaches the network", async (patch) => {
  const generateMossSpeechFailure = await failure(generateMossSpeech("test-key", { ...input, ...patch }, { fetch: unreachable }));
  expect(generateMossSpeechFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
});

it.for(["", " ", "key\nheader"])("invalid speech credentials %# never reach the network", async (key) => {
  const generateMossSpeechFailure = await failure(generateMossSpeech(key, input, { fetch: unreachable }));
  expect(generateMossSpeechFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it.for([
  { url: "http://audio.example.com/out.mp3" },
  { url: "https://user:secret@audio.example.com/out.mp3" },
  { url: "https://audio.example.com/out.mp3#private" },
  { url: "data:audio/mpeg;base64,AAAA" },
  { content_type: "text/html" },
  { status: "FAILED" },
  { object: "audio.voice_generation" },
  { id: "" },
])("malformed speech response %# remains unknown without retry", async (patch) => {
  const error = await failure(generateMossSpeech("test-key", input, answer({ ...result, ...patch })));
  expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/secret|token|test-key|audio\.example/u);
});

it.for([400, 401, 403, 413, 422, 429, 302, 404, 500, 503])("HTTP %s is sanitized without retry", async (status) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return Response.json({ error: { message: "test-key private response", code: "private-code" } }, { status });
  });
  const error = await failure(generateMossSpeech("test-key", input, { fetch }));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 422, 429].includes(status) ? "Rejected" : "Unknown" });
  expect(shown(error)).not.toMatch(/test-key|private/u);
  expect(calls).toBe(1);
});

it("a documented missing voice is a rejection, not an ambiguous routing failure", async () => {
  const generateMossSpeechFailure = await failure(
    generateMossSpeech("test-key", input, answer({ error: { code: "voice_not_found", message: "private" } }, 404)),
  );
  expect(generateMossSpeechFailure).toMatchObject({
    reason: "HttpStatus",
    status: 404,
    code: "voice_not_found",
    outcome: "Rejected",
  });
});

it("speech JSON is bounded even when the vendor returns a successful status", async () => {
  const generateMossSpeechFailure = await failure(generateMossSpeech("test-key", input, answer({ ...result, padding: "x".repeat(1 << 20) })));
  expect(generateMossSpeechFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it.for(["cancel", "timeout"])("%s while reading the speech body stops the transport without resubmitting", async (action) => {
  const started = Promise.withResolvers<void>();
  let canceled = false;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    started.resolve();
    return new Response(
      new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
        cancel: () => {
          canceled = true;
        },
      }),
    );
  };
  const stop = new AbortController();
  const result = failure(generateMossSpeech("test-key", input, { fetch: fetcher, signal: stop.signal }));
  await started.promise;
  if (action === "cancel") {
    stop.abort();
    await result;
  } else {
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  }
  expect(canceled).toBe(true);
  expect(calls).toBe(1);
});

it("async submission returns only the documented task ID and does not poll or download", async () => {
  let calls = 0;
  const fetch = answering(async (request) => {
    calls++;
    expect(await request.json()).toMatchObject({ async: true, stream: false, delivery_method: "url" });
    return Response.json({ task_id: "task-one" }, { status: 202 });
  });
  const mossSpeechTaskCreated = await createMossSpeechTask("test-key", input, { fetch });
  expect(mossSpeechTaskCreated).toEqual({ taskId: "task-one" });
  expect(calls).toBe(1);
});

it("regression: a missing async task_id is unknown and never inferred from another field", async () => {
  const mossSpeechTaskCreatedFailure = await failure(createMossSpeechTask("test-key", input, answer({ id: "task-one", status: "PENDING" })));
  expect(mossSpeechTaskCreatedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});
