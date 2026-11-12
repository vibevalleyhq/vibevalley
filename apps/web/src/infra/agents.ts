import { z } from "zod";

import { type Agent, type AgentProblem, defaultOrchestrator, type OrchestratorLook } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { createSettled } from "#/base/dom.tsx";

import { api } from "./api";
import { defineQuery, retryRead, ready, useAgents, useQuery } from "./query";

/** The profiles work is sent to, the helpers; enabled, only those not switched off. */
export function useWorkAgents(enabled = false) {
  const all = useAgents();
  return (): Agent[] => ready(all, []).filter((a) => a.role === "worker" && (!enabled || a.enabled));
}

/** The orchestrators' profiles, the default one first. */
export function useOrchestrators() {
  const all = useAgents();
  return (): Agent[] =>
    ready(all, [])
      .filter((a) => a.role === "orchestrator")
      .toSorted((a, b) => (a.id === defaultOrchestrator ? -1 : b.id === defaultOrchestrator ? 1 : 0));
}

/** An orchestrator's look (its sprites are manager-<look>); the plain farmer until the profiles are read. */
export const orchestratorLookOf = (agents: readonly Agent[], id = defaultOrchestrator): OrchestratorLook =>
  agents.find((a) => a.id === id)?.look.orchestrator ?? "farmer";

/** A profile by its id, once the profiles are read; undefined for none or one gone. */
export function useAgent(id: () => string | undefined) {
  const all = useAgents();
  return (): Agent | undefined => {
    const want = id();
    return want ? ready(all, []).find((a) => a.id === want) : undefined;
  };
}

/** What the server says is wrong with each of these drafts (agent.validate), by id; empty until it answers. */
const problemsQuery = defineQuery({
  schema: z.array(S.AgentValidation),
  key: (input: { agents: readonly Agent[]; token: string }) => ["agent-check", input.token],
  fetch: (input, context) => api.agent.validate({ agents: [...input.agents] }, context),
  gcTime: 0,
  ...retryRead,
});

export function useAgentProblems(agents: () => readonly Agent[]) {
  const settled = createSettled(agents);
  const got = useQuery(() => problemsQuery({ agents: settled(), token: crypto.randomUUID() }));
  return (): Record<string, AgentProblem[]> => Object.fromEntries(ready(got, []).map((c) => [c.id, c.problems]));
}
