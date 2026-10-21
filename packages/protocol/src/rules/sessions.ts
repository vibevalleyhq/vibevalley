// Finding and changing a session in the core state. Nothing here changes what it is given.

import type { CoreState, PhaseWorking, Session } from "../shapes";

export const sessionOf = (state: CoreState, id: string) => state.sessions.find((h) => h.id === id);

/** The session working the issue now: the latest hired of those on it. */
export function sessionOnIssue(state: CoreState, issue: string): Session | undefined {
  let on: Session | undefined;
  for (const h of state.sessions) if (h.issue === issue && (!on || h.hiredAt >= on.hiredAt)) on = h;
  return on;
}

/** The very same state when there is no such session. */
export function withSession(state: CoreState, id: string, change: (h: Session) => Session): [CoreState, boolean] {
  const i = state.sessions.findIndex((h) => h.id === id);
  if (i < 0) return [state, false];
  const sessions = [...state.sessions];
  sessions[i] = change(sessions[i]!);
  return [{ ...state, sessions }, true];
}

export function whileWorking(state: CoreState, id: string, change: (p: PhaseWorking) => PhaseWorking): [CoreState, boolean] {
  const h = sessionOf(state, id);
  if (!h || h.phase._tag !== "working") return [state, false];
  return withSession(state, id, (h) => ({ ...h, phase: change(h.phase as PhaseWorking) }));
}
