import { Effect, Schema } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";

import { AudioId, audioRequest, MossAudioError } from "./audio-response.ts";

const Cursor = Schema.String.check(Schema.isBetweenCodePoints(1, 8192));
const Input = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 150 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 }))),
  after: Schema.optionalKey(Cursor),
  status: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 128))),
}).check(Schema.makeFilter((input) => input.offset === undefined || input.after === undefined));
const Voice = Schema.Struct({
  id: AudioId,
  object: Schema.Literal("audio.voice"),
  name: Schema.String.check(Schema.isMaxLength(1000)),
  created_at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});

export interface MossVoice {
  readonly id: string;
  readonly name: string;
  readonly createdAtSeconds: number;
}

const Clone = Schema.Struct({
  audio: Schema.instanceOf(Blob).check(
    Schema.makeFilter(
      (audio) =>
        audio.size > 0 &&
        audio.size <= 10_000_000 &&
        ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/flac", "audio/x-flac"].includes(audio.type),
    ),
  ),
  filename: Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/^[^\p{Cc}/\\]+\.(?:wav|mp3|m4a|flac)$/iu)),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  // Duration must come from the caller's media inspection, not a browser or model assertion.
  durationSeconds: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(30)),
});

export const createMossVoice = Effect.fn("Provider.createMossVoice")(
  function* (key: string, input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Clone)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
    );
    const form = new FormData();
    form.append("audio_sample", request.audio, request.filename);
    if (request.name !== undefined) form.append("name", request.name);
    const raw = yield* audioRequest(key, HttpClientRequest.post("https://api.mosi.cn/v1/audio/voices", { body: HttpBody.formData(form) }));
    const voice = yield* Schema.decodeEffect(Schema.fromJsonString(Voice))(raw).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    return { id: voice.id, name: voice.name, createdAtSeconds: voice.created_at } satisfies MossVoice;
  },
  Effect.timeout("300 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))),
);
const Listing = Schema.fromJsonString(
  Schema.Struct({
    object: Schema.Literal("list"),
    data: Schema.Array(Voice).check(Schema.isMaxLength(150)),
    has_more: Schema.Boolean,
    first_id: Schema.optionalKey(Schema.NullOr(AudioId)),
    last_id: Schema.optionalKey(Schema.NullOr(AudioId)),
    next_cursor: Schema.optionalKey(Schema.NullOr(Cursor)),
  }).check(
    Schema.makeFilter((list) => {
      if (list.has_more && !list.next_cursor) return false;
      if (new Set(list.data.map((voice) => voice.id)).size !== list.data.length) return false;
      return (list.first_id ?? undefined) === list.data[0]?.id && (list.last_id ?? undefined) === list.data.at(-1)?.id;
    }),
  ),
);

export const listMossVoices = Effect.fn("Provider.listMossVoices")(
  function* (key: string, input: unknown) {
    const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
    );
    const limit = request.limit ?? 20;
    const raw = yield* audioRequest(
      key,
      HttpClientRequest.get("https://api.mosi.cn/v1/audio/voices", {
        urlParams: {
          limit,
          ...(request.offset !== undefined ? { offset: request.offset } : {}),
          ...(request.after !== undefined ? { after: request.after } : {}),
          ...(request.status !== undefined ? { status: request.status } : {}),
        },
      }),
    );
    const result = yield* Schema.decodeEffect(Listing)(raw).pipe(Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })));
    if (result.data.length > limit) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
    return {
      voices: result.data.map((voice) => ({ id: voice.id, name: voice.name, createdAtSeconds: voice.created_at })),
      hasMore: result.has_more,
      nextCursor: result.next_cursor ?? null,
    };
  },
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))),
);
