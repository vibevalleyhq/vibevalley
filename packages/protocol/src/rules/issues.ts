// Where an issue stands.

import { type CoreState, type Issue, type IssueClose, type IssueDrafting, type IssueStatus, managerAgent } from "../shapes";
import { isBusy } from "./phase";
import { same } from "./same";
import { sessionOf } from "./sessions";
import { statusMoves } from "./moves";
import { standingIn } from "./standing";
import { compare, compareText, or } from "./text";

export const isForManager = (t: Issue) => t.assignee === managerAgent;

/** Done is what was asked for: merged, or answered by the manager. The rest, and a close that does not say how, is canceled. */
const closedStatus = (c: IssueClose | undefined): IssueStatus => (c === "merged" || c === "merged_into_graph" || c === "answered" ? "done" : "canceled");

/** An issue for the manager is in progress while the manager is on it, and waits on the owner once its turn ended,
 * however it ended: only the owner closes it. */
export function issueStatusOf(t: Issue, state: CoreState): IssueStatus {
  if (t.closed !== undefined || t.closedAt !== undefined) return closedStatus(t.closed);
  if (isForManager(t)) return t.handedBack ? "in_review" : "in_progress";
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

const titleMax = 40;

/** One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits;
 * failing those, cut. Lengths are characters. */
export function shortTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const chars = [...line];
  if (chars.length <= titleMax) return line;
  const head = chars.slice(0, titleMax + 1).join("");
  const sentence = /^(.{4,}?)[。！？!?；;]/u.exec(head)?.[1];
  if (sentence) return sentence.trim();
  const pause = Math.max(...[..."：:，,、"].map((p) => head.lastIndexOf(p)));
  if (pause >= 4) return head.slice(0, pause).trim();
  return chars.slice(0, titleMax - 1).join("") + "…";
}

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
    const standing = standingIn({ ...t, status, drafting }, state);
    // The moves read the standing: a round that failed is not harvested, from the moment it fails.
    const moves = statusMoves({ ...t, status, drafting, standing });
    if (status === t.status && same(drafting, t.drafting) && same(standing, t.standing) && same(moves, t.moves)) return;
    next ??= [...state.issues!];
    next[i] = { ...t, status, drafting, standing, moves };
  });
  return next ? { ...state, issues: next } : state;
}

/** What a session is told when merging its base in would conflict. */
export const conflictBrief = (base: string, files: readonly string[]) =>
  `把 ${base} 合进你的分支时有冲突（${files.join("、")}）。请在你的分支上运行 git merge ${base}，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。`;
