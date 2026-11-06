import { Effect } from "effect";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";
import type { OrchestratorHandlers } from "@vibevalley/protocol/api";

import { missing, lookIn } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { Memory } from "#/memory/memory.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";

export const orchestratorHandlers = Effect.gen(function* () {
  const core = yield* Core;
  const memory = yield* Memory;
  const orchestrator = yield* Orchestrator;
  const done: OrchestratorHandlers = {
    "orchestrator.open": () => core.open(),
    "orchestrator.stop": ({ agent }) => orchestrator.stop(agent),
    "orchestrator.eval.create": (body) => orchestrator.markWrong(body.on, body.want, body.agent),
    "orchestrator.archive.list": ({ agent, q }) => memory.archive(agent || defaultOrchestrator, q ?? ""),
    "orchestrator.archive.get": ({ agent, name }) =>
      memory.archiveFile(agent || defaultOrchestrator, name).pipe(
        Effect.filterOrFail(
          (text) => text !== undefined,
          () => missing(t("server.archiveRef", { name }), [lookIn.archive]),
        ),
      ),
  };
  return done;
});
