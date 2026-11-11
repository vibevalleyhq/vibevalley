import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { MossErrorOutcome, MossErrorReason, readMossResponse } from "./response.ts";
import { mossSpeechFormats } from "./speech-models.ts";

export const AudioId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u));
const ErrorCode = Schema.Literals([
  "voice_not_found",
  "task_not_found",
  "unsupported_stream",
  "unsupported_for_stream",
  "unsupported_with_async",
  "unsupported_with_webhook",
  "invalid_field_value",
  "rate_limit_exceeded",
  "concurrency_limit_exceeded",
]);
const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: ErrorCode }) }));
export class MossAudioError extends Schema.TaggedError<MossAudioError, { readonly brand: unique symbol }>()("MossAudioError", {
  reason: MossErrorReason,
  outcome: MossErrorOutcome,
  status: Schema.optionalKey(Schema.Int),
  code: Schema.optionalKey(ErrorCode),
}) {}

const UsageCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const AudioUsage = Schema.Struct({
  input_characters: Schema.optionalKey(UsageCount),
  prompt_tokens: Schema.optionalKey(UsageCount),
  completion_tokens: Schema.optionalKey(UsageCount),
  total_tokens: Schema.optionalKey(UsageCount),
  input_audio_seconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

export interface MossAudioUsage {
  readonly inputCharacters?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly inputAudioSeconds?: number;
}

export function audioUsage(usage: typeof AudioUsage.Type): MossAudioUsage {
  return {
    ...(usage.input_characters !== undefined ? { inputCharacters: usage.input_characters } : {}),
    ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(usage.input_audio_seconds !== undefined ? { inputAudioSeconds: usage.input_audio_seconds } : {}),
  };
}

const mimeTypes: Record<(typeof mossSpeechFormats)[number], readonly string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  pcm: ["audio/pcm", "audio/l16", "application/octet-stream"],
  flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac", "audio/aacp"],
  opus: ["audio/opus", "audio/ogg", "application/ogg"],
};
export const AudioResult = Schema.Struct({
  url: Schema.URLFromString.check(
    Schema.makeFilter((url) => url.href.length <= 8192 && url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""),
  ),
  response_format: Schema.Literals(mossSpeechFormats),
  content_type: Schema.String.check(Schema.isBetweenCodePoints(1, 256)),
}).check(Schema.makeFilter((result) => mimeTypes[result.response_format].includes(result.content_type.split(";")[0]?.trim().toLowerCase() ?? "")));

export const audioRequest = Effect.fnUntraced(
  function* (key: string, request: HttpClientRequest.HttpClientRequest) {
    if (!key.trim() || /\s/u.test(key)) return yield* MossAudioError.make({ reason: "Credentials", outcome: "NotSubmitted" });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(request.pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${key}`, accept: "application/json" })));
    const raw = yield* readMossResponse(response).pipe(
      Effect.catchTag("MossResponseTooLarge", () => Effect.fail(MossAudioError.make({ reason: "TooLarge", outcome: "Unknown" }))),
    );
    if (response.status < 200 || response.status >= 300) {
      const parsed = Schema.decodeOption(ErrorBody)(raw);
      const code = parsed._tag === "Some" ? parsed.value.error.code : undefined;
      return yield* MossAudioError.make({
        reason: "HttpStatus",
        status: response.status,
        outcome:
          [400, 401, 403, 413, 422, 429].includes(response.status) || (response.status === 404 && (code === "voice_not_found" || code === "task_not_found"))
            ? "Rejected"
            : "Unknown",
        ...(code !== undefined ? { code } : {}),
      });
    }
    return raw;
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.catchTag("HttpClientError", () => Effect.fail(MossAudioError.make({ reason: "Network", outcome: "Unknown" }))),
);
