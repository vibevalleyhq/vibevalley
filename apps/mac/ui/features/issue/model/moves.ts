import type { AppliedIssue, Changes, Issue, IssueStatus, IssueUpdate } from "@vibevalley/protocol";
import { omitUndefined, same } from "@vibevalley/protocol/rules";

import { api } from "../../../infra/api";
import { bySeq, defineIntent, type Intent, type Intents, type Sent } from "../../../infra/state/intent";
import type { BoardCard, Lane } from "./cards";

export interface IssueMove {
  readonly id: string;
  readonly revision?: NonNullable<Changes["revision"]>;
  readonly status: IssueStatus;
  /** What the user said with it: the findings of reject, what a reopen asks for. */
  readonly text?: string;
  /** Fields edited and not saved, saved first so the move sees them (starting a todo). */
  readonly edit?: IssueUpdate;
  /** The lane it was dropped on, when it was dragged: where the card shows until the frame catches up. */
  readonly lane?: Lane;
  /** Target sibling card id to insert before (`""` appends to the end) for optimistic board ordering. */
  readonly before?: string;
}

export interface PendingPlacement {
  readonly id: string;
  readonly before: string;
}

export const issueMove = defineIntent<IssueMove, AppliedIssue, "board">({
  slice: "board",
  send: (m, key) => api.issue.status.update(omitUndefined({ id: m.id, status: m.status, text: m.text, edit: m.edit, revision: m.revision, requestKey: key })),
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

/** The issue as its page shows it: the status the user moved it to while the move is on its way, the rest the frame's. */
export function movedIssue(issue: Issue, moves: readonly Intent<IssueMove, AppliedIssue>[]): Issue {
  const m = moves.findLast((x) => x.input.id === issue.id);
  return m && m.phase !== "failed" && m.input.status !== issue.status ? { ...issue, status: m.input.status } : issue;
}

/** Moves `id` right before `before` (`""` or missing target appends to the end) without mutating input. */
function reorderCard(cards: readonly BoardCard[], id: string, before: string): BoardCard[] {
  const from = cards.findIndex((c) => c.id === id);
  if (from === -1) return [...cards];
  const next = [...cards];
  const moving = next[from];
  if (moving === undefined) return next;
  next.splice(from, 1);
  if (before === "") {
    next.push(moving);
    return next;
  }
  const at = next.findIndex((c) => c.id === before);
  if (at === -1) next.push(moving);
  else next.splice(at, 0, moving);
  return next;
}

/** The newest move of each card, laid over the board's cards with optimistic lane and target slot placement. */
export function movedCards(cards: readonly BoardCard[], moves: readonly Intent<IssueMove, AppliedIssue>[]): BoardCard[] {
  const latest = new Map(moves.map((m) => [m.input.id, m]));
  let next = cards.map((c) => {
    const m = latest.get(c.id);
    if (!m) return c;
    return { ...c, lane: m.input.lane ?? c.lane, move: cardMoveOf(m) };
  });
  for (const m of latest.values()) {
    if (m.phase !== "failed" && m.input.before !== undefined) {
      next = reorderCard(next, m.input.id, m.input.before);
    }
  }
  return next;
}

/** Applies in-flight same-lane manual placements optimistically until `issue.update` settles. */
export function placedCards(cards: readonly BoardCard[], placements: readonly PendingPlacement[]): BoardCard[] {
  let next = [...cards];
  for (const p of placements) {
    next = reorderCard(next, p.id, p.before);
  }
  return next;
}
