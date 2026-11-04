// The shapes of the orchestrator's evals (docs/subsystems/orchestrator.md).

export interface OrchestratorEvalRequest {
  /** The orchestrator whose log it is, by its profile id; the default one when none is given. */
  agent?: string;
  on: number;
  want: string;
}

export interface OrchestratorEval {
  id: string;
  file: string;
}
