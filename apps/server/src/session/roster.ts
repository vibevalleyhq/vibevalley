import type * as T from "@vibevalley/protocol";

// Finding and changing a session in the core state. Nothing here changes what it is given.
export const sessionOf = (state: T.WorkspaceState, id: string) => state.sessions.find((h) => h.id === id);

/** The session working the issue now: the latest hired of those on it. */
export function sessionOnIssue(state: T.WorkspaceState, issue: string): T.Session | undefined {
  let on: T.Session | undefined;
  for (const h of state.sessions) if (h.issue === issue && (!on || h.hiredAt >= on.hiredAt)) on = h;
  return on;
}

/** The very same state when there is no such session. */
export function withSession(state: T.WorkspaceState, id: string, change: (h: T.Session) => T.Session): [T.WorkspaceState, boolean] {
  const i = state.sessions.findIndex((h) => h.id === id);
  const current = state.sessions[i];
  if (i < 0 || !current) return [state, false];
  const sessions = [...state.sessions];
  sessions[i] = change(current);
  return [{ ...state, sessions }, true];
}

export const doingOf = (h: T.Session): T.Doing => (h.phase._tag === "working" ? h.phase.doing : { action: "none", label: "" });
