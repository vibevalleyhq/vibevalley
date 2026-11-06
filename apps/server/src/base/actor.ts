export type Actor =
  | { readonly kind: "owner" }
  | { readonly kind: "orchestrator"; readonly forOwner: boolean }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "system" };

export const owner: Actor = { kind: "owner" };
export const system: Actor = { kind: "system" };
/** forOwner: the owner's own words are in the run it acts in. */
export const orchestrator = (forOwner: boolean): Actor => ({ kind: "orchestrator", forOwner });
export const session = (id: string): Actor => ({ kind: "session", id });

/** On the owner's word: the owner, or the orchestrator in a run the owner's words are in. */
export const actsForOwner = (a: Actor): boolean => a.kind === "owner" || (a.kind === "orchestrator" && a.forOwner);
