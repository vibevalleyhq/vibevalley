// The command line and the live evals have no farm to give the Llm its HttpClient: it gets a fetch of its own.

import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { type LlmShape, make } from "@vibevalley/ai/llm";

export const standaloneLlm = (): LlmShape => Effect.runSync(make.pipe(Effect.provide(FetchHttpClient.layer)));
