// An issue's status changed by the owner (a card dragged to another lane, a button on its page, a close or a reopen),
// before the frame shows it: the move is an intent (base/intent.ts) keyed by its request key, so a lost reply sent again
// moves the issue once. The board shows the card in the lane it was dropped on, and the issue's page shows it moving,
// until a frame at least as new as the reply comes; then whatever the frame says (the server may have queued it in 待办
// for want of room). The overlays set the lane or the status, the one thing the owner chose, and nothing the server
// works out.

import type { AppliedIssue, Issue, IssueStatus, IssueUpdate } from "@vibevalley/protocol";
import { omitUndefined, same } from "@vibevalley/protocol/rules";

import { api } from "@/base/api";
import { bySeq, defineIntent, type Intent, type Intents, type Sent } from "@/base/intent";

import type { BoardCard } from "./cards";
import type { Lane } from "./lanes";

export interface IssueMove {
  readonly id: string;
  readonly status: IssueStatus;
  /** What the owner said with it: the findings of 打回, what a reopen asks for. */
  readonly text?: string;
  /** Fields edited and not saved, saved first so the move sees them (starting a 待办). */
  readonly edit?: IssueUpdate;
  /** The lane it was dropped on, when it was dragged: where the card shows until the frame catches up. */
  readonly lane?: Lane;
}

export const issueMove = defineIntent<IssueMove, AppliedIssue>({
  send: (m, key) => api.issue.status.update(omitUndefined({ id: m.id, status: m.status, text: m.text, edit: m.edit, requestKey: key })),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/**
 * One move per issue at a time: the same move again while one is kept is that one (sent again with its key if it failed),
 * and another lets the kept one go.
 */
export function sendMove(moves: Intents<IssueMove, AppliedIssue>, move: IssueMove): Sent<IssueMove, AppliedIssue> {
  const kept = moves.all().find((m) => m.input.id === move.id);
  if (kept && same(kept.input, move)) return { key: kept.key, done: kept.status === "failed" ? moves.retry(kept.key) : Promise.resolve(kept) };
  if (kept) moves.drop(kept.key);
  return moves.send(move);
}

/** A move on its way: `moving` until the frame shows it, `failed` with why until retried or let go. */
export interface CardMove {
  readonly key: string;
  readonly state: "moving" | "failed";
  readonly reason?: string;
}

const cardMoveOf = (m: Intent<IssueMove, AppliedIssue>): CardMove =>
  m.status === "failed" ? { key: m.key, state: "failed", ...(m.reason === undefined ? {} : { reason: m.reason }) } : { key: m.key, state: "moving" };

/** The newest move of an issue, for its page. */
export function issueMoveOf(id: string, moves: readonly Intent<IssueMove, AppliedIssue>[]): CardMove | undefined {
  const m = moves.findLast((x) => x.input.id === id);
  return m && cardMoveOf(m);
}

/** The issue as its page shows it: the status the owner moved it to while the move is on its way, the rest the frame's. */
export function movedIssue(issue: Issue, moves: readonly Intent<IssueMove, AppliedIssue>[]): Issue {
  const m = moves.findLast((x) => x.input.id === issue.id);
  return m && m.status === "pending" && m.input.status !== issue.status ? { ...issue, status: m.input.status } : issue;
}

/** The newest move of each card, laid over the board's cards. */
export function movedCards(cards: readonly BoardCard[], moves: readonly Intent<IssueMove, AppliedIssue>[]): BoardCard[] {
  const latest = new Map(moves.map((m) => [m.input.id, m]));
  return cards.map((c) => {
    const m = latest.get(c.id);
    if (!m) return c;
    return { ...c, lane: m.input.lane ?? c.lane, move: cardMoveOf(m) };
  });
}
