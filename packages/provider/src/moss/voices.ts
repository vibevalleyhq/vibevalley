import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

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
