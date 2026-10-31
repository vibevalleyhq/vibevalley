// A card dragged to another lane, before the frame shows it there: the move is an intent (base/intent.ts) keyed by its
// request key, so a lost reply sent again moves the issue once. The board shows the card in the lane it was dropped on
// until a frame at least as new as the reply comes, then shows whatever the frame says (the server may have queued it
// in 待办 for want of room). The overlay sets the lane, the one thing the owner chose, and nothing the server works out.

import type { AppliedIssue, IssueStatus } from "@vibevalley/protocol";

import { api } from "@/base/api";
import { bySeq, defineIntent, type Intent } from "@/base/intent";

import type { BoardCard } from "./cards";
import type { Lane } from "./lanes";

export interface IssueMove {
  readonly id: string;
  readonly status: IssueStatus;
  /** The lane it was dropped on: where the card shows until the frame catches up. */
  readonly lane: Lane;
}

export const issueMove = defineIntent<IssueMove, AppliedIssue>({
  send: (m, key) => api.issue.status.update({ id: m.id, status: m.status, requestKey: key }),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** A card's move on its way: `moving` until the frame shows it, `failed` with why until retried or put back. */
export interface CardMove {
  readonly key: string;
  readonly state: "moving" | "failed";
  readonly reason?: string;
}

/** The newest move of each card, laid over the board's cards. */
export function movedCards(cards: readonly BoardCard[], moves: readonly Intent<IssueMove, AppliedIssue>[]): BoardCard[] {
  const latest = new Map(moves.map((m) => [m.input.id, m]));
  return cards.map((c) => {
    const m = latest.get(c.id);
    if (!m) return c;
    const move: CardMove =
      m.status === "failed" ? { key: m.key, state: "failed", ...(m.reason === undefined ? {} : { reason: m.reason }) } : { key: m.key, state: "moving" };
    return { ...c, lane: m.input.lane, move };
  });
}
