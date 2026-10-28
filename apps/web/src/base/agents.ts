import { keepPreviousData } from "@tanstack/solid-query";
import { type Agent, type AgentProblem, defaultOrchestrator, type ManagerLook } from "@vibevalley/protocol";
import { api } from "./api";
import { createSettled } from "./util";
import { ready, useAgents, useQuery } from "./query";

/** The profiles work is sent to, the workers; enabled, only those not switched off. */
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
      .sort((a, b) => (a.id === defaultOrchestrator ? -1 : b.id === defaultOrchestrator ? 1 : 0));
}

/** An orchestrator's look (its sprites are manager-<look>); the plain farmer until the profiles are read. */
export const managerLook = (agents: readonly Agent[], id = defaultOrchestrator): ManagerLook => agents.find((a) => a.id === id)?.look.manager ?? "farmer";

/** A profile by its id, once the profiles are read; undefined for none or one gone. */
export function useAgent(id: () => string | undefined) {
  const all = useAgents();
  return (): Agent | undefined => {
    const want = id();
    return want ? ready(all, []).find((a) => a.id === want) : undefined;
  };
}

/** What the server says is wrong with each of these drafts (agent.check), by id; empty until it answers. */
export function useAgentProblems(agents: () => readonly Agent[]) {
  const json = createSettled(() => JSON.stringify(agents()));
  const got = useQuery(() => ({
    queryKey: ["agent-check", json()],
    queryFn: () => api.agent.check({ agents: JSON.parse(json()) as Agent[] }),
    placeholderData: keepPreviousData,
  }));
  return (): Record<string, AgentProblem[]> => Object.fromEntries(ready(got, []).map((c) => [c.id, c.problems]));
}
