import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

import { mossImageModels } from "./image-models.ts";
import { readMossResponse } from "./response.ts";

const Text = Schema.String.check(Schema.isBetweenCodePoints(1, 4000), Schema.isPattern(/\S/u));
const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 2048 }), Schema.isMultipleOf(16));
const Size = Schema.Struct({ width: Dimension, height: Dimension }).check(Schema.makeFilter((size) => size.width * size.height <= 2097152));
const Coordinate = Schema.Finite;
const Layout = Schema.Struct({
  summary: Schema.Struct({ caption: Text, meta: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)), canvas: Schema.optionalKey(Schema.NonEmptyString) }),
  items: Schema.Array(
    Schema.Struct({
      label: Schema.NonEmptyString,
      caption: Text,
      text: Schema.optionalKey(Schema.String),
      bbox: Schema.Tuple([Coordinate, Coordinate, Coordinate, Coordinate]),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  bbox_format: Schema.Literal("yxyx"),
  bbox_coord_space: Schema.Literal("abs_centralized"),
});

const encodeLayout = Schema.encodeEffect(Schema.fromJsonString(Layout));

const MossImageInput = Schema.Struct({
  model: Schema.Literals(mossImageModels),
  prompt: Schema.Union([Text, Layout]),
  size: Schema.optionalKey(Size),
  seed: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  guidance: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  negativePrompt: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(0, 4000))),
  enhance: Schema.optionalKey(Schema.Boolean),
  watermark: Schema.optionalKey(Schema.Boolean),
});

const ErrorCode = Schema.Literals([
  "invalid_field_value",
  "forbidden",
  "prompt_enhancement_refused",
  "safety_guardrail_blocked",
  "resource_not_found",
  "concurrency_limit_exceeded",
  "rate_limit_exceeded",
  "prompt_enhancement_incomplete",
  "upstream_invalid_result",
]);
const ErrorResponse = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: ErrorCode }) }));
const ImageResponse = Schema.fromJsonString(
  Schema.Struct({
    created: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.Tuple([
      Schema.Struct({
        url: Schema.URLFromString.check(Schema.makeFilter((url) => url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "")),
      }),
    ]),
    usage: Schema.Struct({ generated_images: Schema.Literal(1), output_width: Dimension, output_height: Dimension }).check(
      Schema.makeFilter((usage) => usage.output_width * usage.output_height <= 2097152),
    ),
  }),
);

class MossImageError extends Schema.TaggedError<MossImageError, { readonly brand: unique symbol }>()("MossImageError", {
  reason: Schema.Literals(["Credentials", "InvalidInput", "Network", "Timeout", "HttpStatus", "InvalidResponse", "TooLarge"]),
  outcome: Schema.Literals(["NotSubmitted", "Rejected", "Unknown"]),
  status: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(ErrorCode),
}) {}

export const prepareMossImage = Effect.fn("Provider.prepareMossImage")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(MossImageInput)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MossImageError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const size = request.size ?? { width: 1024, height: 1024 };
  if (typeof request.prompt !== "string") {
    for (const item of request.prompt.items) {
      const [top, left, bottom, right] = item.bbox;
      if (top >= bottom || left >= right || top < -size.height / 2 || bottom > size.height / 2 || left < -size.width / 2 || right > size.width / 2)
        return yield* MossImageError.make({ reason: "InvalidInput", outcome: "NotSubmitted" });
    }
  }
  const prompt =
    typeof request.prompt === "string"
      ? request.prompt
      : yield* encodeLayout(request.prompt).pipe(Effect.mapError(() => MossImageError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })));
  if ([...prompt].length > 4000) return yield* MossImageError.make({ reason: "InvalidInput", outcome: "NotSubmitted" });
  return { ...request, prompt, size };
});

export const generateMossImage = Effect.fn("Provider.generateMossImage")(
  function* (key: string, input: unknown) {
    if (!key.trim() || /\s/u.test(key)) return yield* MossImageError.make({ reason: "Credentials", outcome: "NotSubmitted" });
    const request = yield* prepareMossImage(input);
    const { prompt, size } = request;
    const body = yield* HttpBody.json({
      model: request.model,
      prompt,
      size: `${size.width}x${size.height}`,
      n: 1,
      response_format: "url",
      prompt_enhance: request.enhance ?? false,
      output_watermark: { enabled: request.watermark ?? true },
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.steps !== undefined ? { num_inference_steps: request.steps } : {}),
      ...(request.guidance !== undefined ? { guidance_scale: request.guidance } : {}),
      ...(request.negativePrompt !== undefined ? { negative_prompt: request.negativePrompt } : {}),
    }).pipe(Effect.mapError(() => MossImageError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })));
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.post("https://api.mosi.cn/v1/images/generations", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      body,
    });
    const raw = yield* readMossResponse(response).pipe(
      Effect.catchTag("MossResponseTooLarge", () => Effect.fail(MossImageError.make({ reason: "TooLarge", outcome: "Unknown" }))),
    );
    if (response.status < 200 || response.status >= 300) {
      const decoded = Schema.decodeOption(ErrorResponse)(raw);
      return yield* MossImageError.make({
        reason: "HttpStatus",
        status: response.status,
        outcome: [400, 401, 403, 413, 422, 429].includes(response.status) ? "Rejected" : "Unknown",
        ...(decoded._tag === "Some" ? { code: decoded.value.error.code } : {}),
      });
    }
    const result = yield* Schema.decodeEffect(ImageResponse)(raw).pipe(
      Effect.mapError(() => MossImageError.make({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    if (result.usage.output_width !== size.width || result.usage.output_height !== size.height)
      return yield* MossImageError.make({ reason: "InvalidResponse", outcome: "Unknown" });
    // Persist this URL before downloading; a failed download must not trigger another generation.
    return { url: result.data[0].url.href, created: result.created, usage: result.usage };
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("900 seconds"),
  // No request, prompt, signed URL or upstream error body may escape through failures.
  Effect.catchTags({
    HttpClientError: () => Effect.fail(MossImageError.make({ reason: "Network", outcome: "Unknown" })),
    TimeoutError: () => Effect.fail(MossImageError.make({ reason: "Timeout", outcome: "Unknown" })),
  }),
);
