import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { AudioId, AudioResult, audioRequest, MossAudioError } from "./audio-response.ts";

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
});
const Task = Schema.fromJsonString(
  Schema.Union([Waiting, Failed, Audio, Transcription]).check(Schema.makeFilter((task) => task.updated_at >= task.created_at)),
);

export const getMossAudioTask = Effect.fn("Provider.getMossAudioTask")(
  function* (key: string, id: string) {
    const checked = yield* Schema.decodeEffect(AudioId)(id).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
    );
    const raw = yield* audioRequest(key, HttpClientRequest.get(`https://api.mosi.cn/v1/audio/tasks/${checked}`));
    const task = yield* Schema.decodeEffect(Task)(raw).pipe(Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })));
    if (task.id !== checked) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
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
            return { ...base, object: task.object, status: task.status, url: task.url.href, format: task.response_format, contentType: task.content_type };
          case "audio.transcription":
            return { ...base, object: task.object, status: task.status, text: task.text, ...(task.segments !== undefined ? { segments: task.segments } : {}) };
        }
    }
  },
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))),
);
