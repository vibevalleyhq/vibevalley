// A model to talk to: the model, the service that carries the request, and the key, asked for at each request.

import type { Effect } from "effect";
import type { Llm } from "./llm.ts";
import type { AssistantMessage, Context } from "./messages.ts";
import { getModel, type Model, models } from "./models.ts";
import type { RequestOptions } from "./request.ts";

export const defaultModel = "deepseek-flash";

/** No key to ask the model with; the host says where to put one. */
export class MissingKey extends Error {
  constructor() {
    super("no DeepSeek API key");
    this.name = "MissingKey";
  }
}

export interface ModelClient {
  readonly model: Model;
  readonly service: Llm["Service"];
  /** Asked before each request (and each summary), so a key changed meanwhile is used at once. */
  readonly apiKey?: () => string | undefined;
}

/** id empty is defaultModel; the key is the caller's to find. */
export function deepseek(id: string, key: string | (() => string | undefined), service: Llm["Service"]): ModelClient {
  const apiKey = typeof key === "string" ? () => key : key;
  if (!apiKey()) throw new MissingKey();
  const name = id || defaultModel;
  const known = getModel("deepseek", name);
  const model = known ?? { ...models.find((m) => m.id === defaultModel)!, id: name, name };
  return { model, service, apiKey };
}

/** One answer, whole; a failure is its error message. */
export const complete = (llm: ModelClient, context: Context, options: RequestOptions = {}): Effect.Effect<AssistantMessage> =>
  llm.service.complete(llm.model, context, { ...options, apiKey: llm.apiKey?.() ?? "" });
