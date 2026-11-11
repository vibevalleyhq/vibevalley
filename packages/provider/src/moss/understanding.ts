import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

import { MossErrorOutcome, MossErrorReason, readMossResponse } from "./response.ts";
import { mossUnderstandingModels } from "./understanding-models.ts";

const FileId = Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/\S/u));
const MediaUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.href.length <= 8192 && url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""),
);
const Image = Schema.Union([Schema.Struct({ kind: Schema.Literal("image"), fileId: FileId }), Schema.Struct({ kind: Schema.Literal("image"), url: MediaUrl })]);
const Video = Schema.Union([Schema.Struct({ kind: Schema.Literal("video"), fileId: FileId }), Schema.Struct({ kind: Schema.Literal("video"), url: MediaUrl })]);
const Input = Schema.Struct({
  model: Schema.Literals(mossUnderstandingModels),
  text: Schema.String.check(Schema.isBetweenCodePoints(1, 64000), Schema.isPattern(/\S/u)),
  media: Schema.Union([Schema.Array(Image).check(Schema.isMinLength(1), Schema.isMaxLength(5)), Schema.Tuple([Video])]),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
});
const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Response = Schema.fromJsonString(
  Schema.Struct({
    id: FileId,
    model: Schema.NonEmptyString,
    status: Schema.Literals(["completed", "incomplete"]),
    incomplete_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.optionalKey(Schema.NullOr(Schema.String)) }))),
    output: Schema.Array(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String })).check(Schema.isMinLength(1)) }),
    ).check(Schema.isMinLength(1)),
    usage: Schema.Struct({ input_tokens: Tokens, output_tokens: Tokens, total_tokens: Tokens }),
  }),
);

class MossUnderstandingError extends Schema.TaggedError<MossUnderstandingError, { readonly brand: unique symbol }>()("MossUnderstandingError", {
  reason: MossErrorReason,
  outcome: MossErrorOutcome,
  status: Schema.optionalKey(Schema.Int),
}) {}

export const prepareMossUnderstanding = Effect.fn("Provider.prepareMossUnderstanding")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MossUnderstandingError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  return {
    model: request.model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: request.text },
          ...request.media.map((media) => ({
            type: media.kind === "image" ? "input_image" : "input_video",
            ...("fileId" in media ? { file_id: media.fileId } : media.kind === "image" ? { image_url: media.url.href } : { video_url: media.url.href }),
          })),
        ],
      },
    ],
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
  };
});

export const understandMossMedia = Effect.fn("Provider.understandMossMedia")(
  function* (key: string, input: unknown) {
    if (!key.trim() || /\s/u.test(key)) return yield* MossUnderstandingError.make({ reason: "Credentials", outcome: "NotSubmitted" });
    const request = yield* prepareMossUnderstanding(input);
    const body = yield* HttpBody.json(request).pipe(Effect.mapError(() => MossUnderstandingError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })));
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.post("https://api.mosi.cn/v1/responses", { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, body });
    const raw = yield* readMossResponse(response).pipe(
      Effect.catchTag("MossResponseTooLarge", () => Effect.fail(MossUnderstandingError.make({ reason: "TooLarge", outcome: "Unknown" }))),
    );
    if (response.status !== 200)
      return yield* MossUnderstandingError.make({
        reason: "HttpStatus",
        status: response.status,
        outcome: [400, 401, 403, 413, 422, 429].includes(response.status) ? "Rejected" : "Unknown",
      });
    const result = yield* Schema.decodeEffect(Response)(raw).pipe(
      Effect.mapError(() => MossUnderstandingError.make({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    const incompleteReason: "max_output_tokens" | null =
      result.status === "incomplete" && result.incomplete_details?.reason === "max_output_tokens" ? "max_output_tokens" : null;
    return {
      id: result.id,
      model: result.model,
      status: result.status,
      text: result.output.flatMap((item) => item.content.map((part) => part.text)).join("\n"),
      incompleteReason,
      usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, totalTokens: result.usage.total_tokens },
    };
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("180 seconds"),
  Effect.catchTags({
    HttpClientError: () => Effect.fail(MossUnderstandingError.make({ reason: "Network", outcome: "Unknown" })),
    TimeoutError: () => Effect.fail(MossUnderstandingError.make({ reason: "Timeout", outcome: "Unknown" })),
  }),
);
