// The farm's Llm on the command line and in the live evals: a fetch of its own.

import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { type LlmShape, make } from "../ai/llm.ts";

export const standaloneLlm = (): LlmShape => Effect.runSync(make.pipe(Effect.provide(FetchHttpClient.layer)));
