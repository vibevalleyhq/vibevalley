import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Mcp } from "#/gateway/mcp/mcp.ts";
import { chatCompletions } from "#/modules/orchestrator/openai.ts";
import { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { chatCompletionsPath } from "#/modules/orchestrator/situation.ts";

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
          const httpServerRequest = yield* HttpServerRequest.HttpServerRequest;
          const request = yield* HttpServerRequest.toWeb(httpServerRequest, { signal: gone.signal });
          const handle2 = yield* mcp.handle(request);
          return HttpServerResponse.fromWeb(handle2);
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => gone.abort())));
      }),
    );
    yield* router.add("*", chatCompletionsPath, chatCompletions({ answerer: response.answerer("api") }));
  }),
);
