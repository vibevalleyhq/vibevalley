// An issue in the core state: its status, who drafts it, its place in the list and its findings left attention.

import { type WorkspaceState, type Issue, type IssueRefining, type IssueStatus, orchestratorAgent } from "@vibevalley/protocol";
import { isBusy, same } from "@vibevalley/protocol/rules";
import { sessionOf } from "../session/state.ts";
import { statusMoves } from "./moves.ts";
import { attentionIn } from "./attention.ts";
import { compare, compareText, or } from "../base/text.ts";

/** An issue for the orchestrator is in progress while the orchestrator is on it, and waits on the owner once its turn ended,
 * however it ended: only the owner closes it. */
export function issueStatusOf(t: Issue, state: WorkspaceState): IssueStatus {
  // Closed, the verdict is written down: done with what it delivered, else canceled (a close that does not say how too).
  if (t.delivered !== undefined || t.canceled !== undefined || t.closedAt !== undefined) return t.delivered !== undefined ? "done" : "canceled";
  if (isForOrchestrator(t)) return t.handedBack ? "in_review" : "in_progress";
  if (t.graph) {
    switch (t.graph.state) {
      case "splitting":
      case "running":
        return "in_progress";
      case "draft":
      case "paused":
      case "ripe":
        return "in_review";
      case "done":
        return "done";
    }
    return "canceled";
  }
  if (t.task) {
    switch (t.task.state) {
      case "waiting":
        return "backlog";
      case "failed":
        return "in_review";
      case "working": {
        const h = t.task.session !== undefined ? sessionOf(state, t.task.session) : undefined;
        return h && isBusy(h) ? "in_progress" : "in_review";
      }
      case "merged":
        return "done";
    }
    return "canceled";
  }
  const sessions = t.sessions ?? [];
  if (sessions.length > 0) {
    const h = sessionOf(state, sessions[sessions.length - 1]!);
    return !h ? "canceled" : isBusy(h) ? "in_progress" : "in_review";
  }
  return t.queuedAt !== undefined ? "todo" : "backlog";
}

export const keepClosedIssues = 50;

export function issueOrder(a: Issue, b: Issue): number {
  const sentA = (a.sessions ?? []).length > 0;
  const sentB = (b.sessions ?? []).length > 0;
  if (!sentA && !sentB) return or(compare(a.rank ?? 0, b.rank ?? 0), compare(a.createdAt, b.createdAt), compareText(a.id, b.id));
  if (!sentA) return -1;
  if (!sentB) return 1;
  return or(compare(b.createdAt, a.createdAt), compareText(a.id, b.id));
}

/** Keeps the latest keepClosedIssues closed ones that are no one's sub-issue; a sub-issue stays and goes with its parent. */
export function withIssue(all: readonly Issue[] | undefined, t: Issue): Issue[] {
  let next = (all ?? []).filter((x) => x.id !== t.id);
  next.push(t);
  const closed = next.filter((x) => x.closedAt !== undefined && x.parent === undefined);
  if (closed.length > keepClosedIssues) {
    closed.sort((a, b) => compare(b.closedAt!, a.closedAt!));
    const drop = new Set(closed.slice(keepClosedIssues).map((x) => x.id));
    next = next.filter((x) => !drop.has(x.id) && !(x.parent !== undefined && drop.has(x.parent)));
  }
  return next.sort(issueOrder);
}

/** The session drafting an unsent issue: the one on the farm for it with draft set. */
export function issueRefiningOf(t: Issue, state: WorkspaceState): IssueRefining | undefined {
  const h = state.sessions.find((h) => h.refining && h.issue === t.id);
  return h ? { session: h.id, name: h.name } : undefined;
}

/** The same array when none changed. */
export function withIssueStatuses(state: WorkspaceState): WorkspaceState {
  let next: Issue[] | undefined;
  (state.issues ?? []).forEach((t, i) => {
    const status = issueStatusOf(t, state);
    const drafting = issueRefiningOf(t, state);
    const attention = attentionIn({ ...t, status, refining: drafting }, state);
    // The moves read the attention: a round that failed is not harvested, from the moment it fails.
    const moves = statusMoves({ ...t, status, refining: drafting, attention });
    if (status === t.status && same(drafting, t.refining) && same(attention, t.attention) && same(moves, t.moves)) return;
    next ??= [...state.issues!];
    next[i] = { ...t, status, refining: drafting, attention, moves };
  });
  return next ? { ...state, issues: next } : state;
}

/** The weeds a failed acceptance left attention. */
export const openFindings = (t: Issue) => (t.findings ?? []).filter((f) => !f.pulled).length;

export const isForOrchestrator = (t: Issue) => t.assignee === orchestratorAgent;
