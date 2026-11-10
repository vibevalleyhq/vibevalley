import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { getMossAudioTask } from "./audio-tasks.ts";
import { createMossSpeechTask } from "./speech.ts";
import { createMossTranscriptionTask } from "./transcription.ts";

const base = { id: "task-one", object: "audio.speech", created_at: 1, updated_at: 2 };
const success = { ...base, status: "SUCCESS", url: "https://audio.example.com/out.wav", response_format: "wav", content_type: "audio/wav" };
const answer = (body: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))));

it.effect.each(["PENDING", "PROCESSING", "FAILED"])("task %s stays distinct from lookup failures and never exposes upstream diagnostics", (status) =>
  Effect.gen(function* () {
    const mossAudioTask = yield* getMossAudioTask("test-key", base.id);
    expect(mossAudioTask).toEqual({ id: base.id, object: base.object, status, createdAtSeconds: 1, updatedAtSeconds: 2 });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...base, status, error: { message: "test-key private vendor error" } }))),
);

it.effect.each(["audio.speech", "audio.voice_generation"])("%s preserves the actual asynchronous audio format", (object) =>
  Effect.gen(function* () {
    const mossAudioTask = yield* getMossAudioTask("test-key", base.id);
    expect(mossAudioTask).toMatchObject({
      status: "SUCCESS",
      object,
      url: success.url,
      format: "wav",
      contentType: "audio/wav",
    });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...success, object }))),
);

it.effect.each([{ segments: undefined }, { segments: [] }, { segments: [{ speaker: "speaker-1", text: "Hello", start: 0, end: 1.5 }] }])(
  "transcription preserves absent, empty or populated segments %#",
  ({ segments }) =>
    Effect.gen(function* () {
      const task = yield* getMossAudioTask("test-key", base.id);
      expect(task).toMatchObject({ status: "SUCCESS", object: "audio.transcription", text: "Hello" });
      if (segments === undefined) expect(task).not.toHaveProperty("segments");
      else expect(task).toHaveProperty("segments", segments);
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answer({ ...base, object: "audio.transcription", status: "SUCCESS", text: "Hello", ...(segments === undefined ? {} : { segments }) }),
      ),
    ),
);

it.effect.each([
  { ...success, id: "other-task" },
  { ...success, updated_at: 0 },
  { ...success, status: "FUTURE_STATUS" },
  { ...success, object: "other.object" },
  { ...success, url: "http://private.example.com/audio" },
  { ...success, content_type: "audio/mpeg" },
  { ...base, status: "SUCCESS" },
  { ...base, status: "SUCCESS", result: { url: success.url, response_format: "wav", content_type: "audio/wav" } },
  { ...base, object: "audio.transcription", status: "SUCCESS", text: "x", segments: [{ speaker: "one", text: "x", start: 2, end: 1 }] },
])("invalid task receipt %# is not a completed result", (body) =>
  Effect.gen(function* () {
    const mossAudioTaskFailure = yield* getMossAudioTask("test-key", base.id).pipe(Effect.flip);
    expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect.each(["", "../other", "task/other", "task?key=private", "%2e%2e", "a".repeat(257)])("task path input %# cannot escape the fixed endpoint", (id) =>
  Effect.gen(function* () {
    const mossAudioTaskFailure = yield* getMossAudioTask("test-key", id).pipe(Effect.flip);
    expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not request")),
    ),
  ),
);

it.effect("missing task and failed task have different results", () =>
  Effect.gen(function* () {
    const mossAudioTaskFailure = yield* getMossAudioTask("test-key", base.id).pipe(Effect.flip);
    expect(mossAudioTaskFailure).toMatchObject({ reason: "HttpStatus", status: 404, code: "task_not_found" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ error: { code: "task_not_found", message: "private" } }, 404))),
);

it.effect("an asynchronous submission is followed by explicit reads only, with the same account", () => {
  const calls: string[] = [];
  let reads = 0;
  const http = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe("Bearer test-key");
    if (request.method === "POST") return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: base.id }, { status: 202 })));
    reads++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(reads === 3 ? success : { ...base, status: reads === 1 ? "PENDING" : "PROCESSING" })),
    );
  });
  return Effect.gen(function* () {
    const submitted = yield* createMossSpeechTask("test-key", { model: "moss-tts-1.0-pro", text: "Synthetic sample", voice: "voice-one", format: "mp3" });
    expect(calls).toHaveLength(1);
    const tasks = yield* Effect.forEach([1, 2, 3], () => getMossAudioTask("test-key", submitted.taskId));
    expect(tasks.map((task) => task.status)).toEqual(["PENDING", "PROCESSING", "SUCCESS"]);
    expect(tasks[2]).toMatchObject({ format: "wav" });
    expect(calls).toEqual(["POST https://api.mosi.cn/v1/audio/speech", ...Array.from({ length: 3 }, () => "GET https://api.mosi.cn/v1/audio/tasks/task-one")]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("task lookup has a bounded deadline and never resubmits generation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    });
    const fiber = yield* getMossAudioTask("test-key", base.id).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("30 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout" });
    expect(calls).toBe(1);
  }),
);

it.effect("long transcription submits once and preserves overlapping speakers and precise timeline offsets", () => {
  const segments = [
    { speaker: "S02", text: "Later start", start: 35.125, end: 36.875 },
    { speaker: "S01", text: "Overlapping response", start: 35.5, end: 37 },
    { speaker: "S02", text: "Final line", start: 3598, end: 3600 },
  ];
  const calls: string[] = [];
  const http = HttpClient.make((request) => {
    calls.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe("Bearer frozen-account");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          request.method === "POST"
            ? { task_id: base.id, retry_after: 4 }
            : { ...base, object: "audio.transcription", status: "SUCCESS", text: "Full transcript", segments },
        ),
      ),
    );
  });
  return Effect.gen(function* () {
    const submitted = yield* createMossTranscriptionTask("frozen-account", { model: "moss-transcribe-diarize-pro", fileId: "file-one", diarize: true });
    expect(calls).toHaveLength(1);
    const task = yield* getMossAudioTask("frozen-account", submitted.taskId);
    expect(task).toEqual({
      id: base.id,
      object: "audio.transcription",
      status: "SUCCESS",
      text: "Full transcript",
      segments,
      createdAtSeconds: 1,
      updatedAtSeconds: 2,
    });
    expect(task).not.toHaveProperty("duration");
    expect(task).not.toHaveProperty("usage");
    expect(calls).toEqual(["POST https://api.mosi.cn/v1/audio/transcriptions", `GET https://api.mosi.cn/v1/audio/tasks/${base.id}`]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  { segments: [{ speaker: "", text: "x", start: 0, end: 1 }] },
  { segments: [{ speaker: "S01", text: "x", start: -1, end: 1 }] },
  { segments: [{ speaker: "S01", text: "x", start: 2, end: 1 }] },
  { segments: Array.from({ length: 10001 }, () => ({ speaker: "S01", text: "x", start: 0, end: 1 })) },
])("invalid or excessive transcription segments %# cannot become a usable timeline", ({ segments }) =>
  Effect.gen(function* () {
    const mossAudioTaskFailure = yield* getMossAudioTask("test-key", base.id).pipe(Effect.flip);
    expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...base, object: "audio.transcription", status: "SUCCESS", text: "x", segments }))),
);

it.effect.each(["audio.speech", "audio.voice_generation", "audio.transcription"])(
  "%s preserves observed optional usage without deriving missing counts",
  (object) =>
    Effect.gen(function* () {
      const task = yield* getMossAudioTask("test-key", base.id);
      expect(task).toHaveProperty("usage", { inputCharacters: 9, promptTokens: 149, completionTokens: 63, totalTokens: 212 });
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answer({
          ...success,
          object,
          text: "Transcript",
          usage: { input_characters: 9, prompt_tokens: 149, completion_tokens: 63, total_tokens: 212 },
        }),
      ),
    ),
);

it.effect("partial zero-valued audio task usage remains partial and zero", () =>
  Effect.gen(function* () {
    const mossAudioTask = yield* getMossAudioTask("test-key", base.id);
    expect(mossAudioTask).toHaveProperty("usage", { completionTokens: 0 });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...success, usage: { completion_tokens: 0 } }))),
);

it.effect.each([{ total_tokens: -1 }, { input_characters: 0.5 }, { prompt_tokens: "private" }])(
  "malformed task usage %# fails without exposing its content",
  (usage) =>
    Effect.gen(function* () {
      const error = yield* getMossAudioTask("test-key", base.id).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
      expect(Formatter.formatJson(error)).not.toContain("private");
    }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...success, usage }))),
);
