// Who does a thing, and on whose word: every service that changes something takes an Actor and judges by it; only the
// entry points make one (the HTTP handlers: the owner; the orchestrator's tools: the orchestrator, for the owner when the
// owner's words are in its run; a session's tools over /mcp: that session; timers and the patrol: the farm). What is
// kept of it (who set a cron, wrote a memory, changed a task graph) is its kind.

import type { ActorKind } from "@vibevalley/protocol";

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

export const kindOf = (a: Actor): ActorKind => a.kind;
