import { Clock, Context, Effect, Layer, Predicate, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";

import { deepseekModel } from "@vibevalley/provider/deepseek/server";

import type { AssistantMessage, Context as LlmContext } from "./messages.ts";
import { zeroUsage } from "./messages.ts";
import type { Model } from "./models.ts";
import { type RequestOptions, requestInput } from "./request.ts";
import { type AssistantMessageEvent, Fold } from "./response.ts";

// messages.ts keeps pi-ai's shapes as interfaces, not schemas; the fold builds this value itself, so its role is enough to
// tell it apart.
const AnswerSoFar = Schema.declare((u): u is AssistantMessage => Predicate.hasProperty(u, "role") && u.role === "assistant");

export interface StreamOptions extends RequestOptions {
  readonly apiKey: string;
}

/** The model could not be asked or its answer not read: no connection, a refusal by status, a broken stream. */
export class LlmError extends Schema.TaggedError<LlmError, { readonly brand: unique symbol }>()("LlmError", {
  reason: Schema.Literals(["network", "status", "stream"]),
  /** The HTTP status, for status. */
  status: Schema.optionalKey(Schema.Int),
  message: Schema.String,
  /** What had come when it failed. */
  partial: Schema.optionalKey(AnswerSoFar),
  /** The connection's own failure, for network. */
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

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

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  const stream = (model: Model, context: LlmContext, options: StreamOptions): Stream.Stream<AssistantMessageEvent, LlmError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const fold = new Fold(model, yield* Clock.currentTimeMillis);
        const language = yield* deepseekModel({ model: model.id, baseUrl: model.baseUrl, key: options.apiKey }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        const source = yield* language.stream(requestInput(model, context, options)).pipe(
          Effect.mapError(
            (e) =>
              new LlmError({
                reason: e.reason,
                message: e.message,
                ...(e.status !== undefined ? { status: e.status } : {}),
                ...(e.cause !== undefined ? { cause: e.cause } : {}),
              }),
          ),
        );
        const events = source.pipe(
          Stream.mapError((e) => new LlmError({ reason: e.reason, message: e.message, partial: fold.message() })),
          Stream.map((chunk) => fold.chunk(chunk)),
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
