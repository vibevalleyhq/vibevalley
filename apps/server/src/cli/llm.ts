// The farm's Llm on the command line and in the live evals: a fetch of its own, run to Promises here.

import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { llmStreamFn } from "../agent/brain/config.ts";
import { make } from "../ai/llm.ts";

export const standaloneStream = (): StreamFn =>
  llmStreamFn(Effect.runSync(make.pipe(Effect.provide(FetchHttpClient.layer))), (effect, options) => Effect.runPromise(effect, options));
