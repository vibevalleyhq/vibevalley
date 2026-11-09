export type Actor =
  | { readonly kind: "owner" }
  | { readonly kind: "agent"; readonly role: "orchestrator"; readonly forOwner: boolean }
  | { readonly kind: "agent"; readonly role: "worker"; readonly id: string }
  | { readonly kind: "system" };

export const owner: Actor = { kind: "owner" };
export const system: Actor = { kind: "system" };
/** forOwner: the owner's own words are in the run it acts in. */
export const orchestrator = (forOwner: boolean): Actor => ({ kind: "agent", role: "orchestrator", forOwner });
/** A helper at work, by its session's id. */
export const worker = (id: string): Actor => ({ kind: "agent", role: "worker", id });

/** On the owner's word: the owner, or the orchestrator in a run the owner's words are in. */
export const actsForOwner = (a: Actor): boolean => a.kind === "owner" || (a.kind === "agent" && a.role === "orchestrator" && a.forOwner);
