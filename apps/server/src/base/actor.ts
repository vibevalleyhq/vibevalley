export type Actor =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly role: "orchestrator"; readonly forUser: boolean }
  | { readonly kind: "agent"; readonly role: "worker"; readonly id: string }
  | { readonly kind: "system" };

export const user: Actor = { kind: "user" };
export const system: Actor = { kind: "system" };
/** forUser: the user's own words are in the run it acts in. */
export const orchestrator = (forUser: boolean): Actor => ({ kind: "agent", role: "orchestrator", forUser });
/** A helper at work, by its session's id. */
export const worker = (id: string): Actor => ({ kind: "agent", role: "worker", id });

/** On the user's word: the user, or the orchestrator in a run the user's words are in. */
export const actsForUser = (a: Actor): boolean => a.kind === "user" || (a.kind === "agent" && a.role === "orchestrator" && a.forUser);
