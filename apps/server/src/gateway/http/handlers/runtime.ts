import type { RuntimeHandlers } from "@vibevalley/protocol/api";

import { lookIn, orMissing } from "#/base/errors.ts";
import type { Agent } from "#/modules/agent/agent.ts";

export function runtimeHandlers(deps: { readonly agent: Agent }): RuntimeHandlers {
  const agents = deps.agent;
  return {
    "runtime.list": () => agents.runtimes(),
    "runtime.refresh": async ({ id }) => orMissing("runtime " + id, [lookIn.runtime])(await agents.refreshRuntime(id)),
    "runtime.setting.update": async ({ id, ...body }) => orMissing("runtime " + id, [lookIn.runtime])(await agents.updateRuntime(id, body)),
  };
}
