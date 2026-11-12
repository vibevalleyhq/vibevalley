import { type Clock, isAbort, systemClock } from "@vibevalley/async";
import type { DeepSeekChunk } from "@vibevalley/provider/deepseek/response";
import { makeDeepSeekModel } from "@vibevalley/provider/deepseek/server";

import { isRecord } from "../base/json.ts";
import type { AssistantMessage, Context as LlmContext } from "../base/messages.ts";
import { zeroUsage } from "../base/messages.ts";
import type { Model } from "../base/models.ts";
import { type RequestOptions, requestInput } from "./request.ts";
import { type AssistantMessageEvent, Fold } from "./response.ts";

export interface StreamOptions extends RequestOptions {
  readonly apiKey: string;
}

export type LlmErrorReason = "network" | "status" | "stream";

/** The model could not be asked or its answer not read: no connection, a refusal by status, a broken stream. */
export class LlmError extends Error {
  override readonly name = "LlmError";
  readonly reason: LlmErrorReason;
  /** The HTTP status, for status. */
  readonly status: number | undefined;
  /** What had come when it failed. */
  readonly partial: AssistantMessage | undefined;

  /** cause: the connection's own failure, for network. */
  constructor(reason: LlmErrorReason, message: string, more: { readonly status?: number; readonly partial?: AssistantMessage; readonly cause?: unknown } = {}) {
    super(message, more.cause === undefined ? undefined : { cause: more.cause });
    this.reason = reason;
    this.status = more.status;
    this.partial = more.partial;
  }
}

export interface Llm {
  /** Starts with start, ends with done or error; a failure to ask or to read is an LlmError. The signal (or leaving the
   * loop early) stops the request. */
  readonly stream: (model: Model, context: LlmContext, options: StreamOptions, signal?: AbortSignal) => AsyncIterable<AssistantMessageEvent>;
  /** The whole answer; a failure is its error message (stopReason error), as a stream's error event carries one. */
  readonly complete: (model: Model, context: LlmContext, options: StreamOptions, signal?: AbortSignal) => Promise<AssistantMessage>;
}

export interface LlmDeps {
  /** How requests go out; a test gives one that answers itself. Default: the global fetch. */
  readonly fetch?: typeof fetch;
  /** A request's start time. Default: the system clock. */
  readonly clock?: Clock;
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

const reasons: readonly LlmErrorReason[] = ["network", "status", "stream"];

/** The provider's failure (its reason, status and cause) as an LlmError; anything else is not the provider's to say. */
function llmErrorOf(e: unknown, partial: AssistantMessage | undefined): LlmError | undefined {
  if (!(e instanceof Error) || !isRecord(e)) return undefined;
  const reason = reasons.find((r) => r === e.reason);
  if (reason === undefined) return undefined;
  return new LlmError(reason, e.message, {
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(partial !== undefined ? { partial } : {}),
    ...(partial === undefined && e.cause !== undefined ? { cause: e.cause } : {}),
  });
}

export function makeLlm(deps: LlmDeps = {}): Llm {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const clock = deps.clock ?? systemClock;

  async function* stream(model: Model, context: LlmContext, options: StreamOptions, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    const fold = new Fold(model, clock.now());
    const language = makeDeepSeekModel(fetchFn, { model: model.id, baseUrl: model.baseUrl, key: options.apiKey });
    let source: AsyncIterable<DeepSeekChunk>;
    try {
      source = await language.stream(requestInput(model, context, options), signal);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw llmErrorOf(e, undefined) ?? e;
    }
    yield fold.start();
    try {
      for await (const chunk of source) yield* fold.chunk(chunk);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw llmErrorOf(e, fold.message()) ?? e;
    }
    yield* fold.end();
  }

  const complete = async (model: Model, context: LlmContext, options: StreamOptions, signal?: AbortSignal): Promise<AssistantMessage> => {
    const asked = clock.now();
    let last: AssistantMessageEvent | undefined;
    try {
      for await (const e of stream(model, context, options, signal)) last = e;
    } catch (e) {
      if (e instanceof LlmError) return failedMessage(model, asked, e);
      throw e;
    }
    if (last === undefined) return failedMessage(model, asked, new LlmError("stream", "The stream said nothing"));
    return last.type === "done"
      ? last.message
      : last.type === "error"
        ? last.error
        : failedMessage(model, asked, new LlmError("stream", "The stream ended early"));
  };

  return { stream, complete };
}

/** makeLlm, under the name the hosts have called it by. */
export const make = makeLlm;
