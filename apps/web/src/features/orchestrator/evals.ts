// The owner's "this round went wrong" on the orchestrator's trajectory, kept as an eval case: handed to the trajectory,
// whose mark runs it in its Act (features/session's Markable), so its busy and refusal are said there.

import type { OrchestratorEval } from "@vibevalley/protocol";

import { api } from "@/base/api";

export const markWrongOf =
  (agent: string) =>
  (on: number, want: string): Promise<OrchestratorEval> =>
    api.orchestrator.eval.create({ agent, on, want });
