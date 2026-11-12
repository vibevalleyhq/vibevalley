import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface OrchestratorHandlers {
  readonly "orchestrator.open": () => Promise<void>;
  /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
  readonly "orchestrator.stop": (a: { readonly agent?: string }) => Promise<void>;
  /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
  readonly "orchestrator.eval.create": (a: T.OrchestratorEvalRequest) => Promise<T.OrchestratorEval>;
}

export const orchestratorEndpoints: readonly Endpoint[] = [
  {
    op: "orchestrator.open",
    about: [],
    input: undefined,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "orchestrator.stop",
    about: [],
    input: input({ agent: z.exactOptional(z.string()) }),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "orchestrator.eval.create",
    about: [],
    input: S.OrchestratorEvalRequest,
    result: S.OrchestratorEval,
    can: ["user", "remote"],
  },
];
