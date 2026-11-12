import { Hono } from "hono";

import type { Mcp } from "#/gateway/mcp/mcp.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { chatCompletions } from "#/modules/orchestrator/openai.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";
import { chatCompletionsPath } from "#/modules/orchestrator/situation.ts";

export interface McpRouteDeps {
  readonly mcp: Mcp;
  readonly orchestrator: Orchestrator;
  readonly clock: Time;
  readonly log: Logger;
}

export function mcpRoute(deps: McpRouteDeps): Hono {
  const app = new Hono();
  // The caller going away aborts the Web request's signal, as the SDK's handler listens for.
  app.all("/mcp", (c) => deps.mcp.handle(c.req.raw));
  const completions = chatCompletions({ answerer: deps.orchestrator.answerer("api") }, { clock: deps.clock, log: deps.log });
  app.all(chatCompletionsPath, (c) => completions(c.req.raw));
  return app;
}
