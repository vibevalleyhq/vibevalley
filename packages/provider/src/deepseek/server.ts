import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";

import { type DeepSeekInput, encodeDeepSeekRequest } from "./request.ts";
import { decodeDeepSeekChunk } from "./response.ts";

const maxEventSize = 4 << 20;

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

export interface DeepSeekConnection {
  readonly model: string;
  readonly baseUrl: string;
  readonly key: string;
}

export function makeDeepSeekModel(http: HttpClient.HttpClient, connection: DeepSeekConnection) {
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
    return res.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode<DeepSeekError | HttpClientError.HttpClientError, unknown>({ maxEventSize })),
      Stream.catchTags({
        HttpClientError: (e) => Stream.fail(DeepSeekError.make({ reason: "stream", message: `The stream broke: ${e.message}`, cause: e })),
        SseError: (e) => Stream.fail(DeepSeekError.make({ reason: "stream", message: `SSE frame too large: ${e.message}`, cause: e })),
        Retry: () => Stream.empty,
      }),
      Stream.takeWhile((event) => !event.data.startsWith("[DONE]")),
      Stream.mapEffect((event) =>
        decodeStreamChunk(event.data).pipe(
          Effect.mapError(() => DeepSeekError.make({ reason: "stream", message: `Not JSON in the stream: ${event.data.slice(0, 200)}` })),
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
}

export const deepseekModel = Effect.fn("Provider.deepseekModel")(function* (connection: DeepSeekConnection) {
  const http = yield* HttpClient.HttpClient;
  return makeDeepSeekModel(http, connection);
});
