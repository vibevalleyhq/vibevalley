import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type DeepSeekInput, encodeDeepSeekRequest } from "./request.ts";
import { decodeDeepSeekChunk, SseData } from "./response.ts";

class DeepSeekError extends Schema.TaggedError<DeepSeekError, { readonly brand: unique symbol }>()("DeepSeekError", {
  reason: Schema.Literals(["network", "status", "stream"]),
  status: Schema.optionalKey(Schema.Int),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) })));
const decodeStreamChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeErrorBody = Schema.encodeOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

function statusMessage(status: number, text: string): string {
  const shown = Option.flatMap(decodeErrorBody(text), (body) => encodeErrorBody(body.error));
  if (Option.isSome(shown)) return `${status}: ${shown.value}`;
  return `${status} ${text.trim() || "status code (no body)"}`;
}

export const deepseekModel = Effect.fn("Provider.deepseekModel")(function* (connection: {
  readonly model: string;
  readonly baseUrl: string;
  readonly key: string;
}) {
  const http = yield* HttpClient.HttpClient;
  const stream = Effect.fn("DeepSeek.stream")(function* (input: DeepSeekInput) {
    const request = HttpClientRequest.post(`${connection.baseUrl}/chat/completions`).pipe(
      HttpClientRequest.bearerToken(connection.key),
      HttpClientRequest.bodyJsonUnsafe(encodeDeepSeekRequest(connection.model, input)),
    );
    const res = yield* http
      .execute(request)
      .pipe(Effect.mapError((cause) => DeepSeekError.make({ reason: "network", message: `Connection error: ${cause.message}`, cause })));
    if (res.status >= 400) {
      const text = yield* res.text.pipe(
        Effect.tapError((e) => Effect.logDebug("DeepSeek error body could not be read", e)),
        Effect.orElseSucceed(() => ""),
      );
      return yield* DeepSeekError.make({ reason: "status", status: res.status, message: statusMessage(res.status, text) });
    }
    const sse = new SseData();
    return res.stream.pipe(
      Stream.mapError((e) => DeepSeekError.make({ reason: "stream", message: `The stream broke: ${e.message}` })),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => sse.line(line)),
      Stream.filter(Predicate.isNotUndefined),
      Stream.mapEffect((data) =>
        decodeStreamChunk(data).pipe(
          Effect.mapError(() => DeepSeekError.make({ reason: "stream", message: `Not JSON in the stream: ${data.slice(0, 200)}` })),
          Effect.flatMap((chunk) => {
            const error: unknown = Predicate.hasProperty(chunk, "error") ? chunk.error : undefined;
            if (error === undefined || error === null) return Effect.succeed(decodeDeepSeekChunk(chunk));
            const message =
              Predicate.hasProperty(error, "message") && typeof error.message === "string"
                ? Effect.succeed(error.message)
                : encodeJson(error).pipe(
                    Effect.tapError((e) => Effect.logDebug("DeepSeek stream error could not be serialized", e)),
                    Effect.orElseSucceed(() => "The stream reported an error that is not JSON"),
                  );
            return Effect.flatMap(message, (said) => Effect.fail(DeepSeekError.make({ reason: "stream", message: said })));
          }),
        ),
      ),
    );
  });
  return { stream };
});
