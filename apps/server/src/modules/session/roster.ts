import { Function } from "effect";

import type * as T from "@vibevalley/protocol";

// Finding and changing a session in the core state. Nothing here changes what it is given.

/** On duty: the agent's one standing session, its id the profile's and there from startup. The others are hired for a
 * piece of work and leave. Today the role decides it, here alone: an orchestrator is on duty. */
export const isOnDuty = (who: { readonly role: T.AgentRole }): boolean => who.role === "orchestrator";
/** Hired for a piece of work, and gone once it is done: a helper's session. */
export const isHired = (who: { readonly role: T.AgentRole }): boolean => who.role === "worker";
export const sessionOf = (state: T.SpaceState, id: string) => state.sessions.find((h) => h.id === id);

/** The session working the issue now: the latest hired of those on it. */
export function sessionOnIssue(state: T.SpaceState, issue: string): T.Session | undefined {
  let on: T.Session | undefined;
  for (const h of state.sessions) if (h.issue === issue && (!on || h.hiredAt >= on.hiredAt)) on = h;
  return on;
}

/** The very same state when there is no such session. */
export const withSession: {
  (id: string, change: (h: T.Session) => T.Session): (state: T.SpaceState) => [T.SpaceState, boolean];
  (state: T.SpaceState, id: string, change: (h: T.Session) => T.Session): [T.SpaceState, boolean];
} = Function.dual(3, (state: T.SpaceState, id: string, change: (h: T.Session) => T.Session): [T.SpaceState, boolean] => {
  const i = state.sessions.findIndex((h) => h.id === id);
  const current = state.sessions[i];
  if (i < 0 || !current) return [state, false];
  const sessions = [...state.sessions];
  sessions[i] = change(current);
  return [{ ...state, sessions }, true];
});

export const doingOf = (h: T.Session): T.Doing => (h.phase._tag === "working" ? h.phase.doing : { action: "none", label: "" });
