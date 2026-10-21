import { keepPreviousData, useQuery } from "@tanstack/solid-query";
import { type Agent, type AgentIssue, managerAgent } from "@vibevalley/protocol";
import { api } from "./api";
import { createSettled } from "../app/util";
import { ready, useAgents } from "./query";

/** The profiles work is sent to: the manager's is apart. */
export function useWorkAgents() {
  const all = useAgents();
  return (): Agent[] => ready(all, []).filter((a) => a.id !== managerAgent);
}

/** What the server says is wrong with each of these drafts (agent.check), by id; empty until it answers. */
export function useAgentIssues(agents: () => readonly Agent[]) {
  const json = createSettled(() => JSON.stringify(agents()));
  const got = useQuery(() => ({
    queryKey: ["agent-check", json()],
    queryFn: () => api.agent.check({ body: { agents: JSON.parse(json()) as Agent[] } }),
    placeholderData: keepPreviousData,
  }));
  return (): Record<string, AgentIssue[]> => Object.fromEntries(ready(got, []).map((c) => [c.id, c.issues]));
}
