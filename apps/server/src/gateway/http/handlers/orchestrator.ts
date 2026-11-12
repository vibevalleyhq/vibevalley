import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";
import type { OrchestratorHandlers } from "@vibevalley/protocol/api";

import { lookIn, missing } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Orchestrator } from "#/modules/orchestrator/orchestrator.ts";

export function orchestratorHandlers(deps: { readonly core: Core; readonly memory: Memory; readonly orchestrator: Orchestrator }): OrchestratorHandlers {
  const { core, memory, orchestrator } = deps;
  return {
    "orchestrator.open": async () => core.open(),
    "orchestrator.stop": ({ agent }) => orchestrator.stop(agent),
    "orchestrator.eval.create": (body) => orchestrator.markWrong(body.on, body.want, body.agent),
    "orchestrator.archive.list": ({ agent, q }) => memory.archive(agent || defaultOrchestrator, q ?? ""),
    "orchestrator.archive.get": async ({ agent, name }) => {
      const text = await memory.archiveFile(agent || defaultOrchestrator, name);
      if (text === undefined) throw missing(t("server.archiveRef", { name }), [lookIn.archive]);
      return text;
    },
  };
}
