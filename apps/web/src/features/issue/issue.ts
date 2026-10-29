// Which issue a link or a session means, whose it is, and whether it is refined or in a task graph.

import type { Issue, Session, SessionView, WorkspaceView } from "@vibevalley/protocol";
/** Assigned to an orchestrator (orchestrators: their profile ids): it answers it, no helper works it. */
export const isForOrchestrator = (issue: Issue, orchestrators: ReadonlySet<string>) => orchestrators.has(issue.assignee ?? "");

export const issueIs = (issue: Issue, id: string) => issue.id === id || issue.sessions.some((s) => s === id);

/** When it ended; undefined for one on the farm. */
export const endedAt = (s: Session) => (s.phase._tag === "closed" ? s.phase.at : undefined);

/** The session on the farm now for an open issue. */
export function issueSession(core: WorkspaceView | undefined, issue: Issue): SessionView | undefined {
  if (!core || issue.sessions.length === 0 || issue.closedAt !== undefined) return undefined;
  const last = issue.sessions[issue.sessions.length - 1];
  return core.sessions.find((s) => s.id === last);
}

/** A draft came back into it (or the owner wrote it out): it has more than a title. */
export const isRefined = (issue: Issue) => issue.description !== "" || issue.criteria.length > 0;

export const issueInTask = (issue: Issue, session: Session | undefined) =>
  issue.graph !== undefined || issue.parent !== undefined || session?.graph !== undefined || issue.delivered === "merged_into_parent";
