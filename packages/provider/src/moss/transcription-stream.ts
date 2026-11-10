import { Effect, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { FetchHttpClient, HttpBody, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";

import { AudioId, AudioUsage, audioUsage, MossAudioError, type MossAudioUsage } from "./audio-response.ts";
import type { MossTranscriptionSegment } from "./audio-tasks.ts";
import { readMossResponse } from "./response.ts";
import { prepareMossTranscription } from "./transcription.ts";

const maxEventSize = 4 << 20;
const maxWireBytes = 32 << 20;
const maxTextLength = 1 << 20;
const DiarizeModel = Schema.Literals(["moss-transcribe-diarize-pro", "moss-transcribe-diarize-pro-2026-07-03"]);
const Event = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("task.created"),
      task_id: AudioId,
      object: Schema.Literal("audio.transcription"),
      status: Schema.Literal("PROCESSING"),
      model: DiarizeModel,
    }),
    Schema.Struct({ type: Schema.Literal("transcript.text.delta"), delta: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("transcript.segment.done"),
      content_index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      speaker: Schema.String.check(Schema.isBetweenCodePoints(1, 256)),
      start: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      text: Schema.String,
      session_usage: Schema.optionalKey(AudioUsage),
    }).check(Schema.makeFilter((segment) => segment.end >= segment.start)),
    Schema.Struct({ type: Schema.Literal("transcript.text.done"), text: Schema.String, usage: Schema.optionalKey(AudioUsage) }),
    Schema.Struct({ type: Schema.Literal("error") }),
  ]),
);
const decodeEvent = Schema.decodeEffect(Event);

export type MossTranscriptionEvent =
  | { readonly type: "task.created"; readonly taskId: string; readonly model: string }
  | { readonly type: "transcript.text.delta"; readonly text: string }
  | { readonly type: "transcript.segment.done"; readonly index: number; readonly segment: MossTranscriptionSegment; readonly usage?: MossAudioUsage }
  | { readonly type: "transcript.text.done"; readonly text: string; readonly usage?: MossAudioUsage };

function* slices(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) yield bytes.subarray(offset, offset + 65536);
}

const open = Effect.fn("Provider.openMossTranscriptionStream")(function* (key: string, input: unknown) {
  const request = yield* prepareMossTranscription(input);
  if (!Schema.is(DiarizeModel)(request.model)) return yield* MossAudioError.make({ reason: "InvalidInput", outcome: "NotSubmitted" });
  if (!key.trim() || /\s/u.test(key)) return yield* MossAudioError.make({ reason: "Credentials", outcome: "NotSubmitted" });
  const body = yield* HttpBody.json({ ...request, response_format: "verbose_json", stream: true, async: false }).pipe(
    Effect.mapError(() => MossAudioError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const http = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(http).execute(
    HttpClientRequest.post("https://api.mosi.cn/v1/audio/transcriptions", {
      body,
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    yield* readMossResponse(response);
    return yield* MossAudioError.make({
      reason: "HttpStatus",
      status: response.status,
      outcome: [400, 401, 403, 413, 422, 429].includes(response.status) ? "Rejected" : "Unknown",
    });
  }
  if (response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
    return yield* MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" });

  let wireBytes = 0;
  return response.stream.pipe(
    Stream.mapEffect((bytes) => {
      wireBytes += bytes.byteLength;
      return wireBytes > maxWireBytes ? Effect.fail(MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" })) : Effect.succeed(bytes);
    }),
    Stream.flatMap((bytes) => Stream.fromIterable(slices(bytes), { chunkSize: 1 })),
  );
});

export function streamMossTranscription(key: string, input: unknown): Stream.Stream<MossTranscriptionEvent, MossAudioError, HttpClient.HttpClient> {
  return Stream.suspend(() => {
    let deltaLength = 0;
    let segmentLength = 0;
    let segmentCount = 0;
    let eventCount = 0;
    const decode = Effect.fnUntraced(function* (event: Sse.Event): Effect.fn.Return<MossTranscriptionEvent, MossAudioError> {
      if (++eventCount > 100000) return yield* MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" });
      const eventDecoded = yield* decodeEvent(event.data).pipe(Effect.mapError(() => MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" })));
      if (event.event !== "message" && event.event !== eventDecoded.type) return yield* MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" });
      switch (eventDecoded.type) {
        case "task.created":
          if (eventCount !== 1) return yield* MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" });
          return { type: eventDecoded.type, taskId: eventDecoded.task_id, model: eventDecoded.model };
        case "transcript.text.delta":
          deltaLength += eventDecoded.delta.length;
          if (deltaLength > maxTextLength) return yield* MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" });
          return { type: eventDecoded.type, text: eventDecoded.delta };
        case "transcript.segment.done":
          segmentLength += eventDecoded.text.length;
          if (++segmentCount > 10000 || segmentLength > maxTextLength) return yield* MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" });
          return {
            type: eventDecoded.type,
            index: eventDecoded.content_index,
            segment: { speaker: eventDecoded.speaker, text: eventDecoded.text, start: eventDecoded.start, end: eventDecoded.end },
            ...(eventDecoded.session_usage !== undefined ? { usage: audioUsage(eventDecoded.session_usage) } : {}),
          };
        case "transcript.text.done":
          if (eventDecoded.text.length > maxTextLength) return yield* MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" });
          return { type: eventDecoded.type, text: eventDecoded.text, ...(eventDecoded.usage !== undefined ? { usage: audioUsage(eventDecoded.usage) } : {}) };
        case "error":
          return yield* MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" });
      }
    });
    return Stream.unwrap(open(key, input)).pipe(
      Stream.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Stream.catchTag("MossResponseTooLarge", () => Stream.fail(MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" }))),
      // Race the deadline per bounded transport chunk, not once per decoded event.
      Stream.interruptWhen(Effect.sleep("900 seconds").pipe(Effect.andThen(Effect.fail(MossAudioError.make({ reason: "Timeout", outcome: "Unknown" }))))),
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode<MossAudioError | HttpClientError.HttpClientError, unknown>({ maxEventSize })),
      Stream.mapEffect(decode),
      // Only a complete transcript.text.done frame acknowledges success; EOF never does.
      Stream.concat(Stream.fail(MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" }))),
      Stream.takeUntil((event) => event.type === "transcript.text.done"),
      Stream.catchTags({
        HttpClientError: () => Stream.fail(MossAudioError.make({ reason: "Network", outcome: "Unknown" })),
        SseError: () => Stream.fail(MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" })),
        Retry: () => Stream.fail(MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" })),
      }),
    );
  });
}
