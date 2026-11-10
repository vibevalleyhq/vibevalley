import { Effect, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";

import { AudioId, AudioResult, AudioUsage, audioRequest, audioUsage, MossAudioError, type MossAudioUsage } from "./audio-response.ts";
import { type mossSpeechFormats } from "./speech-models.ts";

export interface MossTranscriptionSegment {
  readonly speaker: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface TaskBase {
  readonly id: string;
  readonly createdAtSeconds: number;
  readonly updatedAtSeconds: number;
}

export type MossAudioTask = TaskBase &
  (
    | { readonly object: "audio.speech" | "audio.voice_generation" | "audio.transcription"; readonly status: "PENDING" | "PROCESSING" | "FAILED" }
    | {
        readonly object: "audio.speech" | "audio.voice_generation";
        readonly status: "SUCCESS";
        readonly url: string;
        readonly format: (typeof mossSpeechFormats)[number];
        readonly contentType: string;
        readonly usage?: MossAudioUsage;
      }
    | {
        readonly object: "audio.transcription";
        readonly status: "SUCCESS";
        readonly text: string;
        readonly segments?: readonly MossTranscriptionSegment[];
        readonly usage?: MossAudioUsage;
      }
  );

const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Base = { id: AudioId, created_at: Time, updated_at: Time };
const ObjectType = Schema.Literals(["audio.speech", "audio.voice_generation", "audio.transcription"]);
const Waiting = Schema.Struct({ ...Base, object: ObjectType, status: Schema.Literals(["PENDING", "PROCESSING"]) });
const Failed = Schema.Struct({ ...Base, object: ObjectType, status: Schema.Literal("FAILED") });
const Audio = Schema.Struct({
  ...Base,
  object: Schema.Literals(["audio.speech", "audio.voice_generation"]),
  status: Schema.Literal("SUCCESS"),
  ...AudioResult.fields,
  usage: Schema.optionalKey(AudioUsage),
}).check(Schema.makeFilter(Schema.is(AudioResult)));
const Segment = Schema.Struct({
  speaker: Schema.String.check(Schema.isBetweenCodePoints(1, 256)),
  text: Schema.String,
  start: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(Schema.makeFilter((segment) => segment.end >= segment.start));
const Transcription = Schema.Struct({
  ...Base,
  object: Schema.Literal("audio.transcription"),
  status: Schema.Literal("SUCCESS"),
  text: Schema.String,
  segments: Schema.optionalKey(Schema.Array(Segment).check(Schema.isMaxLength(10000))),
  usage: Schema.optionalKey(AudioUsage),
});
const Task = Schema.fromJsonString(
  Schema.Union([Waiting, Failed, Audio, Transcription]).check(Schema.makeFilter((task) => task.updated_at >= task.created_at)),
);

export const getMossAudioTask = Effect.fn("Provider.getMossAudioTask")(
  function* (key: string, id: string): Effect.fn.Return<MossAudioTask, MossAudioError, HttpClient.HttpClient> {
    const checked = yield* Schema.decodeEffect(AudioId)(id).pipe(
      Effect.mapError(() => MossAudioError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
    );
    const raw = yield* audioRequest(key, HttpClientRequest.get(`https://api.mosi.cn/v1/audio/tasks/${checked}`));
    const task = yield* Schema.decodeEffect(Task)(raw).pipe(Effect.mapError(() => MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" })));
    if (task.id !== checked) return yield* MossAudioError.make({ reason: "InvalidResponse", outcome: "Unknown" });
    const base = { id: task.id, createdAtSeconds: task.created_at, updatedAtSeconds: task.updated_at };
    switch (task.status) {
      case "PENDING":
      case "PROCESSING":
      case "FAILED":
        return { ...base, object: task.object, status: task.status };
      case "SUCCESS":
        switch (task.object) {
          case "audio.speech":
          case "audio.voice_generation":
            return {
              ...base,
              object: task.object,
              status: task.status,
              url: task.url.href,
              format: task.response_format,
              contentType: task.content_type,
              ...(task.usage !== undefined ? { usage: audioUsage(task.usage) } : {}),
            };
          case "audio.transcription":
            return {
              ...base,
              object: task.object,
              status: task.status,
              text: task.text,
              ...(task.segments !== undefined ? { segments: task.segments } : {}),
              ...(task.usage !== undefined ? { usage: audioUsage(task.usage) } : {}),
            };
        }
    }
  },
  Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(MossAudioError.make({ reason: "Timeout", outcome: "Unknown" })),
  }),
);
