import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Mcp } from "#/mcp/mcp.ts";
import { chatCompletions } from "#/orchestrator/openai.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";
import { chatCompletionsPath } from "#/orchestrator/situation.ts";

export const mcpRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const response = yield* Orchestrator;
    yield* router.add(
      "*",
      "/mcp",
      Effect.suspend(() => {
        // The caller going away aborts the Web request, as the SDK's handler listens for.
        const gone = new AbortController();
        return Effect.gen(function* () {
          const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest, { signal: gone.signal });
          return HttpServerResponse.fromWeb(yield* mcp.handle(request));
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => gone.abort())));
      }),
    );
    yield* router.add("*", chatCompletionsPath, chatCompletions({ answerer: response.answerer("api") }));
  }),
);
