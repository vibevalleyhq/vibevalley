// Where an issue stands.

import { type CoreState, type Issue, type IssueClose, type IssueDrafting, type IssueStatus, managerAgent } from "../shapes";
import { isBusy } from "./phase";
import { same } from "./same";
import { sessionOf } from "./sessions";
import { compare, compareText, or } from "./text";

export const isForManager = (t: Issue) => t.assignee === managerAgent;

/** Done is what was asked for: merged, or answered by the manager. The rest, and a close that does not say how, is canceled. */
const closedStatus = (c: IssueClose | undefined): IssueStatus => (c === "merged" || c === "merged_into_graph" || c === "answered" ? "done" : "canceled");

/** An issue for the manager is open only while the manager works on it; a run gone without saying how closes it all the same. */
export function issueStatusOf(t: Issue, state: CoreState): IssueStatus {
  if (t.closed !== undefined || t.closedAt !== undefined) return closedStatus(t.closed);
  if (isForManager(t)) return "in_progress";
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
export function issueDraftingOf(t: Issue, state: CoreState): IssueDrafting | undefined {
  const h = state.sessions.find((h) => h.draft && h.issue === t.id);
  return h ? { session: h.id, name: h.name } : undefined;
}

/** The same array when none changed. */
export function withIssueStatuses(state: CoreState): CoreState {
  let next: Issue[] | undefined;
  (state.issues ?? []).forEach((t, i) => {
    const status = issueStatusOf(t, state);
    const drafting = issueDraftingOf(t, state);
    if (status === t.status && same(drafting, t.drafting)) return;
    next ??= [...state.issues!];
    next[i] = { ...t, status, drafting };
  });
  return next ? { ...state, issues: next } : state;
}

/** What a session is told when merging its base in would conflict. */
export const conflictBrief = (base: string, files: readonly string[]) =>
  `把 ${base} 合进你的分支时有冲突（${files.join("、")}）。请在你的分支上运行 git merge ${base}，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。`;
