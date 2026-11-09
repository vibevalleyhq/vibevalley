import type { AppliedIssue, Issue, IssueStatus, IssueUpdate } from "@vibevalley/protocol";
import { omitUndefined, same } from "@vibevalley/protocol/rules";

import { api } from "#/infra/api.ts";
import { bySeq, defineIntent, type Intent, type Intents, type Sent } from "#/state/intent.ts";

import type { BoardCard, Lane } from "./cards";

export interface IssueMove {
  readonly id: string;
  readonly status: IssueStatus;
  /** What the owner said with it: the findings of reject, what a reopen asks for. */
  readonly text?: string;
  /** Fields edited and not saved, saved first so the move sees them (starting a todo). */
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
  if (kept && same(kept.input, move)) return { key: kept.key, done: kept.phase === "failed" ? moves.retry(kept.key) : Promise.resolve(kept) };
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
  m.phase === "failed" ? { key: m.key, state: "failed", reason: m.fault.reason } : { key: m.key, state: "moving" };

/** The newest move of an issue, for its page. */
export function issueMoveOf(id: string, moves: readonly Intent<IssueMove, AppliedIssue>[]): CardMove | undefined {
  const m = moves.findLast((x) => x.input.id === id);
  return m && cardMoveOf(m);
}

/** The issue as its page shows it: the status the owner moved it to while the move is on its way, the rest the frame's. */
export function movedIssue(issue: Issue, moves: readonly Intent<IssueMove, AppliedIssue>[]): Issue {
  const m = moves.findLast((x) => x.input.id === issue.id);
  return m && m.phase !== "failed" && m.input.status !== issue.status ? { ...issue, status: m.input.status } : issue;
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
