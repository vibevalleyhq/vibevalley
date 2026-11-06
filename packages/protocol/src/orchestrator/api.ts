import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface OrchestratorHandlers<R = never> {
  readonly "orchestrator.open": () => Effect.Effect<void, ApiError, R>;
  /** Ends the orchestrator's run under way and drops what waits for it; the sessions it sent keep working. */
  readonly "orchestrator.stop": (a: { readonly agent?: string }) => Effect.Effect<void, ApiError, R>;
  readonly "orchestrator.archive.list": (a: { readonly agent?: string; readonly q?: string }) => Effect.Effect<T.ArchiveListing, ApiError, R>;
  readonly "orchestrator.archive.get": (a: { readonly agent?: string; readonly name: string }) => Effect.Effect<string, ApiError, R>;
  /** Saves the turn begun at a step of the orchestrator's log as a case for its evals, with what it should have done. */
  readonly "orchestrator.eval.create": (a: T.OrchestratorEvalRequest) => Effect.Effect<T.OrchestratorEval, ApiError, R>;
}

export const orchestratorEndpoints: readonly Endpoint[] = [
  {
    op: "orchestrator.open",
    about: [],
    input: undefined,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.stop",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String) }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.archive.list",
    about: [],
    input: input({ agent: Schema.optionalKey(Schema.String), q: Schema.optionalKey(Schema.String) }),
    result: S.ArchiveListing,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.archive.get",
    about: ["name"],
    input: input({ agent: Schema.optionalKey(Schema.String), name: Schema.String }),
    result: Schema.String,
    can: ["owner", "remote"],
  },
  {
    op: "orchestrator.eval.create",
    about: [],
    input: S.OrchestratorEvalRequest,
    result: S.OrchestratorEval,
    can: ["owner", "remote"],
  },
];
