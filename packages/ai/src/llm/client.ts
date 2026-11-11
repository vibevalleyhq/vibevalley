import { type Effect, Schema } from "effect";

import type { AssistantMessage, Context } from "../base/messages.ts";
import { getModel, type Model, models } from "../base/models.ts";
import type { Llm } from "./llm.ts";
import type { RequestOptions } from "./request.ts";

export const defaultModel = "deepseek-flash";

/** No key to ask the model with; the host says where to put one. */
export class MissingKey extends Schema.TaggedError<MissingKey, { readonly brand: unique symbol }>()("MissingKey", { message: Schema.String }) {}

export interface ModelClient {
  readonly model: Model;
  readonly service: Llm["Service"];
  /** Asked before each request (and each summary), so a key changed meanwhile is used at once. */
  readonly apiKey?: () => string | undefined;
}

/** id empty is defaultModel; the key is the caller's to find. */
export function deepseek(id: string, key: string | (() => string | undefined), service: Llm["Service"]): ModelClient {
  const apiKey = typeof key === "string" ? () => key : key;
  if (!apiKey()) throw MissingKey.make({ message: "no DeepSeek API key" });
  const name = id || defaultModel;
  const known = getModel("deepseek", name);
  const fallback = models.find((m) => m.id === defaultModel);
  if (!fallback) throw new Error(`the default model ${defaultModel} is not in the model table`);
  const model = known ?? { ...fallback, id: name, name };
  return { model, service, apiKey };
}

/** One answer, whole; a failure is its error message. */
export const complete = (llm: ModelClient, context: Context, options: RequestOptions = {}): Effect.Effect<AssistantMessage> =>
  llm.service.complete(llm.model, context, { ...options, apiKey: llm.apiKey?.() ?? "" });
