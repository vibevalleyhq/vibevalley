import { type Actor, defaultOrchestrator, userId } from "@vibevalley/protocol";

export type { Actor };

/** Who calls a farm tool (the orchestrator or a session), read again at each call. */
export interface Caller {
  /** The profile: an orchestrator's own id for an orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the repo it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly repo: string;
  /** The channel the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the user picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** The ingress envelope currently being handled; empty when this run was not opened by one. */
  readonly envelope: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

export type Who = () => Caller;

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
