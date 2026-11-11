import { Effect } from "effect";

import type { CoreHandlers } from "@vibevalley/protocol/api";

import { ServerConfig } from "#/infra/config.ts";

export const coreHandlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const done: CoreHandlers = {
    "server.health.get": () => Effect.succeed({ ok: true, version: config.version }),
  };
  return done;
});
