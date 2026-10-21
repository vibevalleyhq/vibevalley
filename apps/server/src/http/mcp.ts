// The routes served by web-standard handlers: a session's tools over MCP at /mcp, and
// the manager as an OpenAI model at /v1/chat/completions.

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { chatCompletions } from "../agent/brain/openai.ts";
import { Manager } from "../manager/manager.ts";
import { chatCompletionsPath } from "../manager/rules.ts";
import { Mcp } from "../mcp/mcp.ts";
import { callbackLog } from "../base/log.ts";

const web = (handle: (r: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const asked = yield* Effect.orDie(HttpServerRequest.toWeb(request));
    return HttpServerResponse.fromWeb(yield* Effect.promise(() => handle(asked)));
  });

export const mcpRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const mcp = yield* Mcp;
    const manager = yield* Manager;
    yield* router.add("*", "/mcp", web(mcp.handle));
    yield* router.add("*", chatCompletionsPath, web(chatCompletions({ answerer: manager.answerer, log: (line) => logs.info(line) })));
  }),
);
