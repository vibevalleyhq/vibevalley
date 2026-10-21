import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type Agent, type AgentIssue, managerAgent } from "@vibevalley/protocol";
import { api } from "./api";
import { useSettled } from "./settled";

/** Every profile, the manager's too (agent.list); keyed ["agents"], so an edit invalidates it. */
export function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api.agent.list() });
}

/** The profiles work is sent to: the manager's is apart. */
export function useWorkAgents(): Agent[] {
  return (useAgents().data ?? []).filter((a) => a.id !== managerAgent);
}

/** What the server says is wrong with each of these drafts (agent.check), by id; empty until it answers. */
export function useAgentIssues(agents: readonly Agent[]): Record<string, AgentIssue[]> {
  const json = useSettled(JSON.stringify(agents));
  const got = useQuery({
    queryKey: ["agent-check", json],
    queryFn: () => api.agent.check({ body: { agents: JSON.parse(json) as Agent[] } }),
    placeholderData: keepPreviousData,
  }).data;
  return Object.fromEntries((got ?? []).map((c) => [c.id, c.issues]));
}
