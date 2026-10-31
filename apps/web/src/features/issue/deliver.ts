// What an issue delivers, picked by the owner on its page: an intent (state/intent.ts) on issue.update, settled by the
// frame whose seq is the reply's. Until then the pick shows the owner's choice, not the frame's old one; a refused pick
// shows the frame's again, marked failed.

import type { AppliedIssue, Deliverable } from "@vibevalley/protocol";

import { api } from "@/infra/api";
import { bySeq, defineIntent, type Intent } from "@/state/intent";

export interface DeliverPick {
  readonly id: string;
  readonly deliver: Deliverable;
}

export const issueDeliver = defineIntent<DeliverPick, AppliedIssue>({
  // A set: sent twice, it is set once, so it needs no request key.
  send: (p) => api.issue.update({ id: p.id, deliver: p.deliver }),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** The deliverable the pick shows, and whether the owner's choice is on its way or was refused. */
export function shownDeliver(
  id: string,
  frame: Deliverable,
  picks: readonly Intent<DeliverPick, AppliedIssue>[],
): { readonly value: Deliverable; readonly state?: "pending" | "failed" } {
  const p = picks.findLast((x) => x.input.id === id);
  if (!p) return { value: frame };
  return p.status === "failed" ? { value: frame, state: "failed" } : { value: p.input.deliver, state: "pending" };
}
