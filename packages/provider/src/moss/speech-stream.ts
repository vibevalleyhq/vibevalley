import { Effect, Schema, Stream } from "effect";
import { Base64, Sse } from "effect/encoding";
import { FetchHttpClient, HttpBody, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";

import { AudioId, AudioUsage, audioUsage, MossAudioError, type MossAudioUsage } from "./audio-response.ts";
import { readMossResponse } from "./response.ts";
import { prepareMossSpeech } from "./speech.ts";

const maxEventSize = 1 << 20;
const maxAudioFrameBytes = 512 << 10;
const maxAudioBytes = 128 << 20;
const maxWireBytes = 192 << 20;
const FlashModel = Schema.Literals(["moss-tts-1.5-flash", "moss-tts-1.5-flash-2026-06-26"]);
const Event = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("task.created"),
      task_id: AudioId,
      object: Schema.Literal("audio.speech"),
      status: Schema.Literal("PROCESSING"),
      model: FlashModel,
    }),
    Schema.Struct({
      type: Schema.Literal("speech.created"),
      format: Schema.Literal("pcm"),
      sample_rate: Schema.Int.check(Schema.isBetween({ minimum: 8000, maximum: 192000 })),
      channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
      bit_depth: Schema.Literals([8, 16, 24, 32]),
      usage: Schema.optionalKey(AudioUsage),
    }),
    Schema.Struct({
      type: Schema.Literal("speech.audio.delta"),
      audio: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxEventSize)),
      usage: Schema.optionalKey(AudioUsage),
    }),
    Schema.Struct({
      type: Schema.Literal("speech.audio.done"),
      usage: Schema.optionalKey(AudioUsage),
      meta_info: Schema.optionalKey(
        Schema.Struct({
          performance: Schema.optionalKey(Schema.Struct({ audio_duration_s: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) })),
        }),
      ),
    }),
    Schema.Struct({ type: Schema.Literal("error") }),
  ]),
);
const VoiceNotFound = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("voice_not_found") }) }));

export type MossSpeechEvent =
  | { readonly type: "task.created"; readonly taskId: string; readonly model: string }
  | {
      readonly type: "speech.created";
      readonly format: "pcm";
      readonly sampleRate: number;
      readonly channels: number;
      readonly bitDepth: number;
      readonly usage?: MossAudioUsage;
    }
  | { readonly type: "speech.audio.delta"; readonly audio: Uint8Array; readonly usage?: MossAudioUsage }
  | { readonly type: "speech.audio.done"; readonly usage?: MossAudioUsage; readonly durationSeconds?: number };

function* slices(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) yield bytes.subarray(offset, offset + 65536);
}

const open = Effect.fn("Provider.openMossSpeechStream")(function* (key: string, input: unknown) {
  const request = yield* prepareMossSpeech(input);
  if (!Schema.is(FlashModel)(request.model) || request.response_format !== "pcm")
    return yield* new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" });
  if (!key.trim() || /\s/u.test(key)) return yield* new MossAudioError({ reason: "Credentials", outcome: "NotSubmitted" });
  const { delivery_method: _delivery, ...prepared } = request;
  const body = yield* HttpBody.json({ ...prepared, stream: true, stream_format: "sse", async: false }).pipe(
    Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const http = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(http).execute(
    HttpClientRequest.post("https://api.mosi.cn/v1/audio/speech", {
      body,
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    const raw = yield* readMossResponse(response);
    const missingVoice = Schema.decodeOption(VoiceNotFound)(raw)._tag === "Some";
    return yield* new MossAudioError({
      reason: "HttpStatus",
      status: response.status,
      outcome: [400, 401, 403, 413, 422, 429].includes(response.status) || (response.status === 404 && missingVoice) ? "Rejected" : "Unknown",
      ...(missingVoice ? { code: "voice_not_found" } : {}),
    });
  }
  if (response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
    return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });

  let wireBytes = 0;
  let audioBytes = 0;
  let frameBytes = 0;
  let eventCount = 0;
  let taskCreated = false;
  const decode = Effect.fnUntraced(function* (event: Sse.Event): Effect.fn.Return<MossSpeechEvent, MossAudioError> {
    if (++eventCount > 100000) return yield* new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });
    const value = yield* Schema.decodeEffect(Event)(event.data).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    if (event.event !== "message" && event.event !== value.type) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
    switch (value.type) {
      case "task.created":
        if (taskCreated || frameBytes !== 0) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
        taskCreated = true;
        return { type: value.type, taskId: value.task_id, model: value.model };
      case "speech.created":
        if (frameBytes !== 0) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
        frameBytes = (value.channels * value.bit_depth) / 8;
        return {
          type: value.type,
          format: value.format,
          sampleRate: value.sample_rate,
          channels: value.channels,
          bitDepth: value.bit_depth,
          ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}),
        };
      case "speech.audio.delta": {
        if (frameBytes === 0) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
        if (value.audio.length > Math.ceil(maxAudioFrameBytes / 3) * 4) return yield* new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });
        const audio = yield* Effect.fromResult(Base64.decode(value.audio)).pipe(
          Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
        );
        audioBytes += audio.byteLength;
        if (audio.byteLength > maxAudioFrameBytes || audioBytes > maxAudioBytes) return yield* new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });
        if (audio.byteLength === 0) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
        return { type: value.type, audio, ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}) };
      }
      case "speech.audio.done": {
        if (frameBytes === 0 || audioBytes === 0 || audioBytes % frameBytes !== 0)
          return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
        const durationSeconds = value.meta_info?.performance?.audio_duration_s;
        return {
          type: value.type,
          ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        };
      }
      case "error":
        return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
    }
  });
  return response.stream.pipe(
    Stream.mapEffect((bytes) => {
      wireBytes += bytes.byteLength;
      return wireBytes > maxWireBytes ? Effect.fail(new MossAudioError({ reason: "TooLarge", outcome: "Unknown" })) : Effect.succeed(bytes);
    }),
    Stream.flatMap((bytes) => Stream.fromIterable(slices(bytes), { chunkSize: 1 })),
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode<MossAudioError | HttpClientError.HttpClientError, unknown>({ maxEventSize })),
    Stream.rechunk(1),
    Stream.mapEffect(decode),
    // EOF is not a completion receipt, including EOF after a partial SSE event.
    Stream.concat(Stream.fail(new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" }))),
    Stream.takeUntil((event) => event.type === "speech.audio.done"),
  );
});

export function streamMossSpeech(key: string, input: unknown): Stream.Stream<MossSpeechEvent, MossAudioError, HttpClient.HttpClient> {
  return Stream.unwrap(open(key, input)).pipe(
    Stream.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Stream.interruptWhen(Effect.sleep("300 seconds").pipe(Effect.andThen(Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))))),
    Stream.catchTags({
      HttpClientError: () => Stream.fail(new MossAudioError({ reason: "Network", outcome: "Unknown" })),
      MossResponseTooLarge: () => Stream.fail(new MossAudioError({ reason: "TooLarge", outcome: "Unknown" })),
      SseError: () => Stream.fail(new MossAudioError({ reason: "TooLarge", outcome: "Unknown" })),
      Retry: () => Stream.fail(new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
    }),
  );
}
