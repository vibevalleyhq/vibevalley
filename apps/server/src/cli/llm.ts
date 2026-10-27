// The farm's Llm on the command line and in the live evals: a fetch of its own, run to Promises here.

import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import type { LlmOn } from "../agent/brain/config.ts";
import { make } from "../ai/llm.ts";

export const standaloneLlm = (): LlmOn => ({
  service: Effect.runSync(make.pipe(Effect.provide(FetchHttpClient.layer))),
  run: (effect, options) => Effect.runPromise(effect, options),
});
