import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, isBusy, issueScopeOf, latestSessionIdOf, omitUndefined, same, stageWantsUser } from "@vibevalley/protocol/rules";

import { compare, compareText, or } from "#/base/order.ts";
import { sessionOf } from "#/modules/session/roster.ts";

import { statusMoves } from "./moves.ts";

export type Finding = T.Issue["findings"][number];
export type IssueCanceled = NonNullable<T.Issue["canceled"]>;
export type IssueChildDraft = T.IssueSplitRequest["tasks"][number];
export type IssueConstraints = NonNullable<T.Issue["constraints"]>;
export type IssueMandate = T.Issue["mandate"];
export type IssueRefining = NonNullable<T.Issue["refining"]>;
export type Landing = NonNullable<T.Issue["delivered"]>;

const awaitsFeedback = (issue: Pick<T.Issue, "questions">, session: Pick<T.Session, "phase" | "lastRun"> | undefined) =>
  session?.phase._tag === "resting" && session.lastRun?.outcome === "completed" && issue.questions.length === 0;

/** The conflict a preview of the issue's branch shows; none when it goes in clean. */
export const conflictOf = (changes: { readonly base: string; readonly conflicts?: readonly string[] }): T.Issue["conflict"] =>
  changes.conflicts && changes.conflicts.length > 0 ? { base: changes.base, files: [...changes.conflicts] } : undefined;

const move = (act: T.IssueAct, status: T.IssueStatus, words: T.ActWords = "none"): T.IssueAction => ({ act, does: "move", status, words });
const say = (act: T.IssueAct): T.IssueAction => ({ act, does: "say" });
const stop: T.IssueAction = { act: "stop", does: "stop" };
const close = move("close", "canceled");

/** session is the issue's newest one, undefined while none is on the farm. A child issue stands with its parent while its parent is open. */
export function issueStageOf(t: T.Issue, session: T.Session | undefined): T.IssueStage {
  const last = session?.lastRun;
  // Completing follows what the issue delivers, not who did the work: an answer is taken (acknowledged), a change completed
  // (merged, or kept on its branch).
  const finish = move(t.deliver === "answer" ? "acknowledge" : "complete", "done");
  // Sent before, it is taken up again with what to do this time; never sent, it goes back to the backlog.
  const sent = executionsOf(t).length > 0 || t.lastRun !== undefined;
  const reopen = sent ? move("reopen", "todo", "required") : move("reopen", "backlog");
  switch (t.status) {
    case "done":
      return { state: "done", ...at(t.closedAt), acts: t.delivered === "merged_into_parent" ? [] : [reopen] };
    case "canceled":
      return { state: "canceled", ...at(t.closedAt), lead: "reopen", acts: [reopen] };
    case "backlog":
      return t.refining
        ? { state: "draft", since: t.createdAt, acts: [] }
        : { state: "draft", since: t.createdAt, lead: "start", acts: [move("start", "todo"), close] };
    case "todo":
      return { state: "queued", since: t.queuedAt ?? t.createdAt, acts: [close] };
    case "in_progress": {
      if (awaitsFeedback(t, session)) return { state: "working", ...at(last?.at), lead: "tell", acts: [say("tell"), close] };
      if (session?.phase._tag === "working") {
        const phase = session.phase;
        if (phase.quietSince !== undefined) return { state: "stuck", stuck: "quiet", since: phase.quietSince, lead: "stop", acts: [stop, say("tell"), close] };
        return { state: "working", since: phase.since, acts: [say("tell"), stop, close] };
      }
      if (!session?.lastRun && (!t.lastRun || t.lastRun.endedAt === undefined))
        return { state: "working", since: t.lastRun?.startedAt ?? t.createdAt, acts: [close] };
      return issueStageOf({ ...t, status: "in_review" }, session);
    }
    case "in_review": {
      // Run by no session on the farm (an in-process agent's): its latest run says how it ended. A failed one cannot be taken as done.
      if (!session && t.lastRun) {
        const ended = t.lastRun.outcome ?? "completed";
        const done = at(t.lastRun.endedAt);
        if (ended === "failed") return { state: "stuck", stuck: "failed", ...done, lead: "close", acts: [close] };
        return ended === "interrupted"
          ? { state: "stuck", stuck: "interrupted", ...done, lead: finish.act, acts: [finish, close] }
          : { state: "reviewing", ...done, lead: finish.act, acts: [finish, close] };
      }
      const since = last?.at;
      // Stuck, moving it back to todo with no words is the server's own for why: settle the conflict, mend, go on.
      if (t.conflict && t.deliver === "change")
        return { state: "stuck", stuck: "conflict", ...at(since), lead: "resolve", acts: [move("resolve", "todo"), say("tell"), close] };
      if (t.questions.length > 0) return { state: "asking", ...at(since), lead: "answer", acts: [say("answer"), close] };
      // An answer issue's round that handed back no answer it could read did not get it done either.
      const unread = t.deliver === "answer" && last?.outcome === "completed" && t.answer === undefined;
      if (last?.outcome === "failed" || unread)
        return { state: "stuck", stuck: "failed", ...at(since), lead: "cure", acts: [move("cure", "todo"), say("tell"), close] };
      // Stopped halfway (stopped or restarted): the work goes on first; what is there can still be completed.
      if (last?.outcome === "interrupted")
        return { state: "stuck", stuck: "interrupted", ...at(since), lead: "resume", acts: [move("resume", "todo"), finish, say("tell"), close] };
      // Completing is the acceptance. Sending it back takes the findings, unless the orchestrator already passed it.
      const reject: T.IssueAction[] = t.reviewedAt === undefined ? [move("reject", "todo", "required")] : [];
      return { state: "reviewing", ...at(since), lead: finish.act, acts: [finish, ...reject, say("tell"), close] };
    }
  }
}

const at = (since: number | undefined) => (since !== undefined ? { since } : {});

export function issueStageIn(t: T.Issue, state: T.SpaceState): T.IssueStage {
  const last = latestSessionIdOf(t);
  return issueStageOf(t, last === undefined ? undefined : sessionOf(state, last));
}

const spaces = /\s+/u;

/** The issues a filter picks, newest first: the open ones unless it asks for closed ones or names a closed status; waiting on
 * the user, the longest waiting first. */
export function pickIssues(all: readonly T.Issue[], f: T.IssueFilter, now: number): T.Issue[] {
  const words = (f.text ?? "").split(spaces).filter(Boolean);
  const repo = (f.repo ?? "").trim();
  let found = all.filter(
    (item) =>
      (f.status ? item.status === f.status : f.closed === true || (item.status !== "done" && item.status !== "canceled")) &&
      (f.wantsUser !== true || stageWantsUser(item.stage.state)) &&
      (!repo || item.repo === repo) &&
      words.every((w) => (item.title + "\n" + item.description).includes(w)),
  );
  if (f.wantsUser === true) found = found.toSorted((a, b) => (a.stage.since ?? now) - (b.stage.since ?? now));
  return f.limit != null && f.limit > 0 ? found.slice(0, Math.trunc(f.limit)) : found;
}

export const isClosed = (s: T.IssueStatus) => s === "done" || s === "canceled";

interface StatusContext {
  readonly sessionOf: (id: string) => T.Session | undefined;
  readonly childrenOf: (id: string) => readonly T.Issue[] | undefined;
}

function statusIn(t: T.Issue, ctx: StatusContext): T.IssueStatus {
  // Closed, the verdict is written down: done with what it delivered, else canceled (a close that does not say how too).
  if (t.delivered !== undefined || t.canceled !== undefined || t.closedAt !== undefined) return t.delivered !== undefined ? "done" : "canceled";
  const latestSession = latestSessionIdOf(t);
  const h = latestSession === undefined ? undefined : ctx.sessionOf(latestSession);
  if (h?.phase._tag === "working") return "in_progress";
  const children = ctx.childrenOf(t.id);
  if (children && children.length > 0) {
    const statuses = children.map((child) => statusIn(child, ctx));
    if (statuses.every(isClosed)) return "in_review";
    if (statuses.some((status) => status !== "backlog")) return "in_progress";
  }
  if (latestSession !== undefined) {
    if (!h) return "todo";
    const unfinished = t.questions.length > 0 || h.lastRun?.outcome !== "completed" || (t.deliver === "answer" && t.answer === undefined);
    return isBusy(h) || awaitsFeedback(t, h) || unfinished ? "in_progress" : "in_review";
  }
  if (t.queuedAt !== undefined) return "todo";
  if (t.lastRun) return t.lastRun.endedAt === undefined || t.lastRun.outcome !== "completed" || t.questions.length > 0 ? "in_progress" : "in_review";
  return "backlog";
}

export function issueStatusOf(t: T.Issue, state: T.SpaceState): T.IssueStatus {
  return statusIn(t, {
    sessionOf: (id) => sessionOf(state, id),
    childrenOf: (id) => state.issues.filter((child) => child.parent === id),
  });
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

const draftEntryOf = (h: T.Session): readonly [string, IssueRefining] | undefined =>
  h.scope?.kind === "draft" ? [h.scope.id, { session: h.id, name: h.name }] : undefined;

interface StatusLookup extends StatusContext {
  readonly refining: ReadonlyMap<string, IssueRefining>;
}

function lookupOf(state: T.SpaceState): StatusLookup {
  const sessions = new Map<string, T.Session>();
  const refining = new Map<string, IssueRefining>();
  for (const h of state.sessions) {
    sessions.set(h.id, h);
    const draft = draftEntryOf(h);
    if (draft && !refining.has(draft[0])) refining.set(draft[0], draft[1]);
  }
  const children = new Map<string, T.Issue[]>();
  for (const item of state.issues) {
    if (item.parent === undefined) continue;
    const list = children.get(item.parent);
    if (list) list.push(item);
    else children.set(item.parent, [item]);
  }
  return {
    sessionOf: (id) => sessions.get(id),
    childrenOf: (id) => children.get(id),
    refining,
  };
}

export function issueRefiningOf(t: T.Issue, state: T.SpaceState): IssueRefining | undefined {
  for (const h of state.sessions) {
    const draft = draftEntryOf(h);
    if (draft && draft[0] === t.id) return draft[1];
  }
  return undefined;
}

/** The same array when none changed. */
export function withIssueStatuses(state: T.SpaceState): T.SpaceState {
  if (state.issues.length === 0) return state;
  const lookup = lookupOf(state);
  let next: T.Issue[] | undefined;
  state.issues.forEach((t, i) => {
    const status = statusIn(t, lookup);
    const drafting = lookup.refining.get(t.id);
    const last = latestSessionIdOf(t);
    const stage = issueStageOf(omitUndefined({ ...t, status, refining: drafting }), last === undefined ? undefined : lookup.sessionOf(last));
    // The moves read the stage: a round that failed is not completed, from the moment it fails.
    const moves = statusMoves(omitUndefined({ ...t, status, refining: drafting, stage }));
    if (status === t.status && same(drafting, t.refining) && same(stage, t.stage) && same(moves, t.moves)) return;
    next ??= [...state.issues];
    next[i] = omitUndefined({ ...t, status, refining: drafting, stage, moves });
  });
  return next ? { ...state, issues: next } : state;
}

export function keepsSessionResting(issues: readonly T.Issue[], session: Pick<T.Session, "scope">): boolean {
  const scopeIssue = issueScopeOf(session);
  return scopeIssue !== undefined && issues.some((issue) => issue.id === scopeIssue && issue.pullRequest?.state === "open");
}

export function withReportedAnswer(
  issues: T.Issue[],
  session: Pick<T.Session, "id" | "scope">,
  report: { readonly outcome: T.Outcome; readonly answer?: T.IssueAnswer },
): T.Issue[] {
  const scopeIssue = issueScopeOf(session);
  if (!scopeIssue || report.outcome !== "completed") return issues;
  const item = issues.find((issue) => issue.id === scopeIssue);
  if (!item || item.deliver !== "answer" || latestSessionIdOf(item) !== session.id) return issues;
  return withIssue(issues, omitUndefined({ ...item, answer: report.answer }));
}

/** The findings still open: a failed acceptance's, until the next acceptance passes. */
export const openFindings = (t: T.Issue) => t.findings.filter((f) => !f.resolved).length;

/** Assigned to an agent on duty (onDuty: whether a profile id is one's): its standing session answers it, none is hired for it. */
export const assignedOnDuty = (t: T.Issue, onDuty: (id: string) => boolean) => onDuty(assignedAgentOf(t) ?? "");
