import type { Issue, Session, SessionView, WorkspaceView } from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
/** An orchestrator answers it: no helper works it. */
export const isForOrchestrator = (issue: Issue, orchestrators: ReadonlySet<string>) => orchestrators.has(assignedAgentOf(issue) ?? "");

export const issueIs = (issue: Issue, id: string) => issue.id === id || sessionIdsOf(issue).some((session) => session === id);

/** undefined while it is still running. */
export const endedAt = (s: Session) => (s.phase._tag === "closed" ? s.phase.at : undefined);

export function issueSession(core: WorkspaceView | undefined, issue: Issue): SessionView | undefined {
  if (!core || issue.closedAt !== undefined) return undefined;
  const last = latestSessionIdOf(issue);
  if (last === undefined) return undefined;
  return core.sessions.find((s) => s.id === last);
}

export const isRefined = (issue: Issue) => issue.description !== "" || issue.criteria.length > 0;
