import type * as T from "@vibevalley/protocol";
import { isBusy, omitUndefined, same } from "@vibevalley/protocol/rules";

import { compare, compareText, or } from "@/base/order.ts";
import { sessionOf } from "@/session/roster.ts";

import { attentionIn } from "./attention.ts";
import { statusMoves } from "./moves.ts";

/** One rule whoever does the work: a session on the farm says where its issue stands; an issue run by no session (an
 * in-process agent's, the orchestrator's) is in progress while its latest run goes on and waits on the owner once it
 * ended, however it ended: only the owner closes it. */
export function issueStatusOf(t: T.Issue, state: T.WorkspaceState): T.IssueStatus {
  // Closed, the verdict is written down: done with what it delivered, else canceled (a close that does not say how too).
  if (t.delivered !== undefined || t.canceled !== undefined || t.closedAt !== undefined) return t.delivered !== undefined ? "done" : "canceled";
  if (t.graph) {
    switch (t.graph.state) {
      case "splitting":
      case "running":
        return "in_progress";
      case "draft":
      case "paused":
      case "ready":
        return "in_review";
      case "done":
        return "done";
      case "abandoned":
        break;
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
      case "skipped":
        break;
    }
    return "canceled";
  }
  const sessions = t.sessions;
  if (sessions.length > 0) {
    const h = sessionOf(state, sessions[sessions.length - 1]!);
    return !h ? "canceled" : isBusy(h) ? "in_progress" : "in_review";
  }
  if (t.lastRun) return t.lastRun.endedAt === undefined ? "in_progress" : "in_review";
  return t.queuedAt !== undefined ? "todo" : "backlog";
}

export const keepClosedIssues = 50;

export function issueOrder(a: T.Issue, b: T.Issue): number {
  const sentA = a.sessions.length > 0;
  const sentB = b.sessions.length > 0;
  if (!sentA && !sentB) return or(compare(a.rank ?? 0, b.rank ?? 0), compare(a.createdAt, b.createdAt), compareText(a.id, b.id));
  if (!sentA) return -1;
  if (!sentB) return 1;
  return or(compare(b.createdAt, a.createdAt), compareText(a.id, b.id));
}

/** Keeps the latest keepClosedIssues closed ones that are no one's sub-issue; a sub-issue stays and goes with its parent. */
export function withIssue(all: readonly T.Issue[] | undefined, t: T.Issue): T.Issue[] {
  let next = (all ?? []).filter((x) => x.id !== t.id);
  next.push(t);
  const closed = next.flatMap((x) => (x.closedAt !== undefined && x.parent === undefined ? [{ id: x.id, at: x.closedAt }] : []));
  if (closed.length > keepClosedIssues) {
    closed.sort((a, b) => compare(b.at, a.at));
    const drop = new Set(closed.slice(keepClosedIssues).map((x) => x.id));
    next = next.filter((x) => !drop.has(x.id) && !(x.parent !== undefined && drop.has(x.parent)));
  }
  return next.toSorted(issueOrder);
}

export function issueRefiningOf(t: T.Issue, state: T.WorkspaceState): T.IssueRefining | undefined {
  const h = state.sessions.find((h) => h.refining && h.issue === t.id);
  return h ? { session: h.id, name: h.name } : undefined;
}

/** The same array when none changed. */
export function withIssueStatuses(state: T.WorkspaceState): T.WorkspaceState {
  let next: T.Issue[] | undefined;
  state.issues.forEach((t, i) => {
    const status = issueStatusOf(t, state);
    const drafting = issueRefiningOf(t, state);
    const attention = attentionIn(omitUndefined({ ...t, status, refining: drafting }), state);
    // The moves read the attention: a round that failed is not completed, from the moment it fails.
    const moves = statusMoves(omitUndefined({ ...t, status, refining: drafting, attention }));
    if (status === t.status && same(drafting, t.refining) && same(attention, t.attention) && same(moves, t.moves)) return;
    next ??= [...state.issues];
    next[i] = omitUndefined({ ...t, status, refining: drafting, attention, moves });
  });
  return next ? { ...state, issues: next } : state;
}

/** The findings still open: a failed acceptance's, until the next acceptance passes. */
export const openFindings = (t: T.Issue) => t.findings.filter((f) => !f.resolved).length;

/** Assigned to an orchestrator (orchestrator: whether a profile id is one's): it answers it, no session works it. */
export const isForOrchestrator = (t: T.Issue, orchestrator: (id: string) => boolean) => orchestrator(t.assignee ?? "");

export const isClosed = (s: T.IssueStatus) => s === "done" || s === "canceled";
