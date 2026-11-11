import { type Actor, defaultOrchestrator, userId } from "@vibevalley/protocol";

export type { Actor };

export const user: Actor = { kind: "user", id: userId };
export const system: Actor = { kind: "system", id: "system" };
/** forUser: the user's own words are in the run it acts in. */
export const orchestrator = (forUser: boolean, id: string = defaultOrchestrator): Actor => ({
  kind: "agent",
  id,
  role: "orchestrator",
  forUser,
});
/** A helper at work, by its session's id. */
export const worker = (id: string): Actor => ({ kind: "agent", id, role: "worker" });

/** On the user's word: the user, or the orchestrator in a run the user's words are in. */
export const actsForUser = (a: Actor): boolean => a.kind === "user" || (a.kind === "agent" && a.role === "orchestrator" && a.forUser === true);
