import type { OrchestratorHandlers } from "@vibevalley/protocol/api";

import type { Core } from "#/core/core.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";

export function orchestratorHandlers(deps: { readonly core: Core; readonly orchestrator: Orchestrator }): OrchestratorHandlers {
  const { core, orchestrator } = deps;
  return {
    "orchestrator.open": async () => core.open(),
    "orchestrator.stop": ({ agent }) => orchestrator.stop(agent),
    "orchestrator.eval.create": (body) => orchestrator.markWrong(body.on, body.want, body.agent),
  };
}
