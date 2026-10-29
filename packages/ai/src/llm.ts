// The farm's models over the wire: a request (request.ts) out, its stream read (response.ts) back, as pi-ai's events.

import { Clock, Context, Data, Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { AssistantMessage, Context as LlmContext } from "./messages.ts";
import { zeroUsage } from "./messages.ts";
import type { Model } from "./models.ts";
import { type RequestOptions, requestBody } from "./request.ts";
import { type AssistantMessageEvent, Fold, SseData } from "./response.ts";

export interface StreamOptions extends RequestOptions {
  readonly apiKey: string;
}

/** The model could not be asked or its answer not read: no connection, a refusal by status, a broken stream. What the
 * model did answer (content filtered, no finish) ends the stream as an error event instead, as pi-ai's does. */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly reason: "network" | "status" | "stream";
  /** The HTTP status, for status. */
  readonly status?: number;
  readonly message: string;
  /** What had come when it failed. */
  readonly partial?: AssistantMessage;
}> {}

export class Llm extends Context.Service<
  Llm,
  {
    /** Starts with start, ends with done or error; interrupting it stops the request. */
    readonly stream: (model: Model, context: LlmContext, options: StreamOptions) => Stream.Stream<AssistantMessageEvent, LlmError>;
    /** The whole answer; a failure is its error message (stopReason error), as a stream's error event carries one. */
    readonly complete: (model: Model, context: LlmContext, options: StreamOptions) => Effect.Effect<AssistantMessage>;
  }
>()("vibevalley/Llm") {
  static readonly layer = Layer.effect(
    Llm,
    Effect.suspend(() => make),
  );
}

/** A failed request as the message a turn keeps: what had come, stopReason error. */
export const failedMessage = (model: Model, timestamp: number, e: LlmError): AssistantMessage => ({
  ...(e.partial ?? {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    timestamp,
  }),
  stopReason: "error",
  errorMessage: e.message,
});

/** As pi-ai words a refusal: the status and the body's error object, else its text. */
function statusMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (body.error && typeof body.error === "object") return `${status}: ${JSON.stringify(body.error)}`;
  } catch {
    // Not JSON: the text as it came.
  }
  return `${status} ${text.trim() || "status code (no body)"}`;
}

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const stream = (model: Model, context: LlmContext, options: StreamOptions): Stream.Stream<AssistantMessageEvent, LlmError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const fold = new Fold(model, yield* Clock.currentTimeMillis);
        const failed = (reason: LlmError["reason"], message: string) => new LlmError({ reason, message, partial: fold.message() });
        const request = HttpClientRequest.post(`${model.baseUrl}/chat/completions`).pipe(
          HttpClientRequest.bearerToken(options.apiKey),
          HttpClientRequest.bodyJsonUnsafe(requestBody(model, context, options)),
        );
        const res = yield* http.execute(request).pipe(Effect.mapError((e) => new LlmError({ reason: "network", message: `Connection error: ${e.message}` })));
        if (res.status >= 400) {
          const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new LlmError({ reason: "status", status: res.status, message: statusMessage(res.status, text) });
        }
        const sse = new SseData();
        const events = res.stream.pipe(
          Stream.mapError((e) => failed("stream", `The stream broke: ${e.message}`)),
          Stream.decodeText(),
          Stream.splitLines,
          Stream.mapEffect((line) => {
            const data = sse.line(line);
            if (data === undefined) return Effect.succeed([] as AssistantMessageEvent[]);
            return Effect.try({ try: () => JSON.parse(data) as unknown, catch: () => failed("stream", `Not JSON in the stream: ${data.slice(0, 200)}`) }).pipe(
              Effect.flatMap((chunk) => {
                const error = (chunk as { error?: { message?: unknown } } | null)?.error;
                return error
                  ? Effect.fail(failed("stream", typeof error.message === "string" ? error.message : JSON.stringify(error)))
                  : Effect.succeed(fold.chunk(chunk));
              }),
            );
          }),
          Stream.flattenIterable,
        );
        return Stream.make(fold.start()).pipe(Stream.concat(events), Stream.concat(Stream.suspend(() => Stream.fromIterable(fold.end()))));
      }),
    );

  const complete = (model: Model, context: LlmContext, options: StreamOptions) =>
    Effect.gen(function* () {
      const asked = yield* Clock.currentTimeMillis;
      const last = yield* stream(model, context, options).pipe(
        Stream.runLast,
        Effect.map((e) => (e._tag === "Some" ? e.value : undefined)),
        Effect.catchTag("LlmError", (e) => Effect.succeed(failedMessage(model, asked, e))),
      );
      if (last === undefined) return failedMessage(model, asked, new LlmError({ reason: "stream", message: "The stream said nothing" }));
      if ("role" in last) return last;
      return last.type === "done"
        ? last.message
        : last.type === "error"
          ? last.error
          : failedMessage(model, asked, new LlmError({ reason: "stream", message: "The stream ended early" }));
    });

  return Llm.of({ stream, complete });
});
