// The routes served by web-standard handlers: a session's tools over MCP at /mcp, and
// the orchestrator as an OpenAI model at /v1/chat/completions.

import { Clock, Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/http";
import { chatCompletions } from "@/orchestrator/openai.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";
import { chatCompletionsPath } from "@/orchestrator/model.ts";
import { Mcp } from "@/mcp/mcp.ts";
import { callbackLog } from "@/base/log.ts";

export const mcpRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const mcp = yield* Mcp;
    const orchestrator = yield* Orchestrator;
    const clock = yield* Clock.Clock;
    yield* router.add("*", "/mcp", HttpEffect.fromWebHandler(mcp.handle));
    yield* router.add(
      "*",
      chatCompletionsPath,
      HttpEffect.fromWebHandler(
        chatCompletions({ answerer: orchestrator.answerer("api"), log: (line) => logs.info(line), now: () => clock.currentTimeMillisUnsafe() }),
      ),
    );
  }),
);
