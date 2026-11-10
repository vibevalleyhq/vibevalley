import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { mossSpeechLanguages, mossSpeechModels } from "./speech-models.ts";
import { createMossSpeechTask, generateMossSpeech, prepareMossSpeech } from "./speech.ts";

const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

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
const answer = (body: unknown, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))));

it.effect.each(mossSpeechModels)("%s submits once with explicit credentials and URL delivery", (model) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech");
      expect(request.headers.authorization).toBe("Bearer test-key");
      const serviceOption2 = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      expect(serviceOption2).toMatchObject({ _tag: "Some", value: { redirect: "manual" } });
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toEqual({
        model,
        input: input.text,
        voice_id: input.voice,
        response_format: "mp3",
        delivery_method: "url",
        stream: false,
        async: false,
      });
      return HttpClientResponse.fromWeb(request, Response.json(result));
    }),
  );
  return Effect.gen(function* () {
    const speech = yield* generateMossSpeech("test-key", { ...input, model });
    expect(speech).toEqual({ id: result.id, url: result.url, format: "mp3", contentType: "audio/mpeg", createdAt: 1 });
    expect(speech).not.toHaveProperty("usage");
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("Flash languages and pause controls are preserved with explicit false metadata", () =>
  Effect.forEach(
    mossSpeechLanguages,
    (language) =>
      Effect.gen(function* () {
        const request = yield* prepareMossSpeech({
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
      }),
    { discard: true },
  ),
);

it.effect.each([
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
])("unsupported or invalid speech input %# never reaches the network", (patch) =>
  Effect.gen(function* () {
    const generateMossSpeechFailure = yield* generateMossSpeech("test-key", { ...input, ...patch }).pipe(Effect.flip);
    expect(generateMossSpeechFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect.each(["", " ", "key\nheader"])("invalid speech credentials %# never reach the network", (key) =>
  Effect.gen(function* () {
    const generateMossSpeechFailure = yield* generateMossSpeech(key, input).pipe(Effect.flip);
    expect(generateMossSpeechFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect.each([
  { url: "http://audio.example.com/out.mp3" },
  { url: "https://user:secret@audio.example.com/out.mp3" },
  { url: "https://audio.example.com/out.mp3#private" },
  { url: "data:audio/mpeg;base64,AAAA" },
  { content_type: "text/html" },
  { status: "FAILED" },
  { object: "audio.voice_generation" },
  { id: "" },
])("malformed speech response %# remains unknown without retry", (patch) =>
  Effect.gen(function* () {
    const error = yield* generateMossSpeech("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/secret|token|test-key|audio\.example/u);
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...result, ...patch }))),
);

it.effect.each([400, 401, 403, 413, 422, 429, 302, 404, 500, 503])("HTTP %s is sanitized without retry", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json({ error: { message: "test-key private response", code: "private-code" } }, { status })),
    );
  });
  return Effect.gen(function* () {
    const error = yield* generateMossSpeech("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 422, 429].includes(status) ? "Rejected" : "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/test-key|private/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("a documented missing voice is a rejection, not an ambiguous routing failure", () =>
  Effect.gen(function* () {
    const generateMossSpeechFailure = yield* generateMossSpeech("test-key", input).pipe(Effect.flip);
    expect(generateMossSpeechFailure).toMatchObject({
      reason: "HttpStatus",
      status: 404,
      code: "voice_not_found",
      outcome: "Rejected",
    });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ error: { code: "voice_not_found", message: "private" } }, 404))),
);

it.effect("speech JSON is bounded even when the vendor returns a successful status", () =>
  Effect.gen(function* () {
    const generateMossSpeechFailure = yield* generateMossSpeech("test-key", input).pipe(Effect.flip);
    expect(generateMossSpeechFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ ...result, padding: "x".repeat(1 << 20) }))),
);

it.effect.each(["cancel", "timeout"])("%s while reading the speech body stops the transport without resubmitting", (action) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let canceled = false;
    let calls = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, undefined);
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
              cancel: () => {
                canceled = true;
              },
            }),
          ),
        );
      }),
    );
    const fiber = yield* generateMossSpeech("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    if (action === "cancel") yield* Fiber.interrupt(fiber);
    else {
      yield* TestClock.adjust("300 seconds");
      const fiber2 = yield* Fiber.join(fiber);
      expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    }
    expect(canceled).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("async submission returns only the documented task ID and does not poll or download", () => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON");
    expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toMatchObject({ async: true, stream: false, delivery_method: "url" });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ task_id: "task-one" }, { status: 202 })));
  });
  return Effect.gen(function* () {
    const mossSpeechTaskCreated = yield* createMossSpeechTask("test-key", input);
    expect(mossSpeechTaskCreated).toEqual({ taskId: "task-one" });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("regression: a missing async task_id is unknown and never inferred from another field", () =>
  Effect.gen(function* () {
    const mossSpeechTaskCreatedFailure = yield* createMossSpeechTask("test-key", input).pipe(Effect.flip);
    expect(mossSpeechTaskCreatedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer({ id: "task-one", status: "PENDING" }))),
);
