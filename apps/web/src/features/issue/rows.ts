// The board's and the list's rows. The frame keeps every open issue and the newest closed ones (with the sessions on the
// farm now), so those are read from it alone and a move shows on the next frame; issue.history.list adds what the frame
// does not keep: the sessions that have left, and with 更早的 the older closed issues. An issue is held once, by the frame.

import type { IssueHistory, Session, WorkspaceView } from "@vibevalley/protocol";

/**
 * Each issue the frame keeps, its sessions found on the farm, in the history, or (one that left after the history was
 * read) as the frame last had it; the history's own rows after them with `older`. undefined before the first frame.
 */
export function boardRows(
  core: WorkspaceView | undefined,
  history: readonly IssueHistory[] | undefined,
  older: boolean,
  seen: ReadonlyMap<string, Session> = new Map(),
): IssueHistory[] | undefined {
  if (!core) return undefined;
  const read = new Map((history ?? []).map((r) => [r.issue.id, r]));
  const present = new Map<string, Session>(core.sessions.map((s) => [s.id, s]));
  const live = core.issues.map((issue): IssueHistory => {
    const row = read.get(issue.id);
    return {
      issue,
      sessions: issue.sessions.flatMap((id) => present.get(id) ?? row?.sessions.find((s) => s.id === id) ?? seen.get(id) ?? []),
      missingSessions: (row?.missingSessions ?? []).filter((id) => issue.sessions.includes(id) && !present.has(id)),
    };
  });
  if (!older || !history) return live;
  const kept = new Set(core.issues.map((i) => i.id));
  return [...live, ...history.filter((r) => !kept.has(r.issue.id))];
}

/**
 * What the history adds to the frame changes only when an issue gets a session or one leaves the farm: the history is
 * read again when this does, not on every move or edit.
 */
export const historyKey = (core: WorkspaceView | undefined): string =>
  core
    ? `${core.issues
        .filter((i) => i.sessions.length > 0)
        .map((i) => `${i.id}:${i.sessions.join(",")}`)
        .join(";")}|${core.sessions.map((s) => s.id).join(",")}`
    : "";
