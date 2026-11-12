import type { CoreHandlers } from "@vibevalley/protocol/api";

import type { ServerConfig } from "#/infra/config.ts";

export function coreHandlers(deps: { readonly config: ServerConfig }): CoreHandlers {
  return {
    "server.health.get": async () => ({ ok: true, version: deps.config.version }),
  };
}
