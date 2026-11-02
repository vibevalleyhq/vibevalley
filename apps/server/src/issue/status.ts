import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, isBusy, latestSessionIdOf, omitUndefined, same } from "@vibevalley/protocol/rules";

import { compare, compareText, or } from "@/base/order.ts";
import { sessionOf } from "@/session/roster.ts";

import { awaitsPullRequest } from "./followup.ts";
import { statusMoves } from "./moves.ts";
import { issueStageIn } from "./stage.ts";

export function issueStatusOf(t: T.Issue, state: T.WorkspaceState): T.IssueStatus {
  // Closed, the verdict is written down: done with what it delivered, else canceled (a close that does not say how too).
  if (t.delivered !== undefined || t.canceled !== undefined || t.closedAt !== undefined) return t.delivered !== undefined ? "done" : "canceled";
  const active = latestSessionIdOf(t);
  if (active && sessionOf(state, active)?.phase._tag === "working") return "in_progress";
  const children = state.issues.filter((child) => child.parent === t.id);
  if (children.length > 0) {
    const statuses = children.map((child) => issueStatusOf(child, state));
    if (statuses.every((status) => status === "done" || status === "canceled")) return "in_review";
    if (statuses.some((status) => status !== "backlog")) return "in_progress";
  }
  const latestSession = latestSessionIdOf(t);
  if (latestSession !== undefined) {
    const h = sessionOf(state, latestSession);
    return !h ? "todo" : isBusy(h) || awaitsPullRequest(t, h) ? "in_progress" : "in_review";
  }
  if (t.queuedAt !== undefined) return "todo";
  if (t.lastRun) return t.lastRun.endedAt === undefined ? "in_progress" : "in_review";
  return t.queuedAt !== undefined ? "todo" : "backlog";
}

export const keepClosedIssues = 50;

export function issueOrder(a: T.Issue, b: T.Issue): number {
  const sentA = executionsOf(a).length > 0;
  const sentB = executionsOf(b).length > 0;
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
    const stage = issueStageIn(omitUndefined({ ...t, status, refining: drafting }), state);
    // The moves read the stage: a round that failed is not completed, from the moment it fails.
    const moves = statusMoves(omitUndefined({ ...t, status, refining: drafting, stage }));
    if (status === t.status && same(drafting, t.refining) && same(stage, t.stage) && same(moves, t.moves)) return;
    next ??= [...state.issues];
    next[i] = omitUndefined({ ...t, status, refining: drafting, stage, moves });
  });
  return next ? { ...state, issues: next } : state;
}

/** The findings still open: a failed acceptance's, until the next acceptance passes. */
export const openFindings = (t: T.Issue) => t.findings.filter((f) => !f.resolved).length;

/** Assigned to an orchestrator (orchestrator: whether a profile id is one's): it answers it, no session works it. */
export const isForOrchestrator = (t: T.Issue, orchestrator: (id: string) => boolean) => orchestrator(assignedAgentOf(t) ?? "");

export const isClosed = (s: T.IssueStatus) => s === "done" || s === "canceled";
