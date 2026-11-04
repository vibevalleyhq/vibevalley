import { Clock, Context, Effect, Layer, Option, Schedule, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf, shortTitle } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { templateCatalog } from "#/agent/seed.ts";
import { actsForOwner, type Actor } from "#/base/actor.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import type { Due } from "#/cron/cron.ts";
import { type ApiError, missing, lookIn, refused } from "#/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Project } from "#/project/project.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { type Hired, type HireOptions, type SessionNews, Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";

import { assignTo } from "./assignment.ts";
import { findingsOf, milestonesOf } from "./brief.ts";
import { filledKinds, sentTitles } from "./creation.ts";
import { type Dispatched, issueDispatch } from "./dispatch.ts";
import { merging } from "./merge.ts";
import { nextSteps } from "./moves.ts";
import { needsOwner } from "./prompts.ts";
import { issueRecords } from "./records.ts";
import { kept, openQuestions, refinement } from "./refinement.ts";
import { jsonOrNull, nullText } from "./rows.ts";
import { issueSettling, type StatusOptions } from "./settle.ts";
import { issueSplitting } from "./split.ts";
import { conflictOf, isClosed, isForOrchestrator, keepClosedIssues, pickIssues } from "./status.ts";

export class Issue extends Context.Service<
  Issue,
  {
    readonly list: () => Effect.Effect<T.Issue[]>;
    /** The board's issues a filter picks (issue.list). */
    readonly query: (f: T.IssueFilter) => Effect.Effect<T.Issue[]>;
    /** The issues the board holds now (open, and the latest closed). */
    readonly onBoard: () => readonly T.Issue[];
    readonly get: (id: string) => Effect.Effect<T.Issue, ApiError>;
    readonly add: (req: T.IssueRequest, mandate: T.IssueMandate) => Effect.Effect<T.Issue, ApiError>;
    /** On the owner's word only (actsForOwner). */
    readonly edit: (id: string, upd: T.IssueUpdate, by: Actor) => Effect.Effect<T.Issue, ApiError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
    readonly scheduled: (due: Due, input: T.Trigger) => Effect.Effect<T.Issue, ApiError>;
    readonly split: (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) => Effect.Effect<string, ApiError>;
    /** agent: moving to todo, the profile (id or name) that takes it on; another than its own hands it over. On the owner's
     * word only (actsForOwner). */
    readonly setStatus: (id: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Effect.Effect<T.Issue, ApiError>;
    /** Stops the turn of the session working it; the session stays, and a word starts the next. */
    readonly stop: (id: string) => Effect.Effect<void, ApiError>;
    /** What setStatus would do with the same request, refused as it would be; nothing changes. edit: the owner's unsaved
     * fields, as the move would see them once saved. */
    readonly previewStatus: (id: string, to: T.IssueStatus, text: string, opt?: StatusOptions, edit?: T.IssueUpdate) => Effect.Effect<T.Preview, ApiError>;
    /** What remove would do, refused as it would be; nothing changes. */
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** An issue's id from what the owner and the orchestrator call it: #41 or 41, its id, or the id of a session that worked it. */
    readonly idOf: (ref: string) => Effect.Effect<string, ApiError>;
    readonly comment: (id: string, text: string, sendKey?: string) => Effect.Effect<void, ApiError>;
    /** The owner's look counts for the game; anyone else's does not. */
    readonly changes: (id: string, by: Actor) => Effect.Effect<T.Changes, ApiError>;
    readonly review: (id: string, req: IssueReviewRequest) => Effect.Effect<T.Issue, ApiError>;
    readonly refine: (id: string, word: string, channel: string) => Effect.Effect<T.Issue, ApiError>;
    readonly history: () => Effect.Effect<T.IssueHistory[]>;
    readonly timeline: (id: string) => Effect.Effect<T.IssueTimeline, ApiError>;
    readonly templates: (project: string) => Effect.Effect<T.ProjectTemplates, ApiError>;
    /** Sends a session for work that is not written down first (the orchestrator sending someone at once, a task's step): its issue is made from the brief. */
    readonly hire: (agent: T.Agent, brief: string, project: string, opt?: HireOptions) => Effect.Effect<Hired>;
    readonly refreshPullRequests: Effect.Effect<void>;
    readonly refreshQueue: Effect.Effect<void>;
    readonly submitPullRequest: (session: string, summary?: string) => Effect.Effect<string, ApiError>;
  }
>()("vibevalley/Issue") {
  static readonly layer = Layer.effect(
    Issue,
    Effect.suspend(() => make),
  );
}

/** A verdict on what was handed back: passed, or not, with the findings (or words) it is mended by. */
export interface IssueReviewRequest {
  readonly pass: boolean;
  readonly findings?: readonly string[];
  readonly text?: string;
}

/** Only while the issue is still open: a completion the owner chose (kept, none) is written before its session leaves,
 * and a child issue merges into its parent, so it does not merge into main here. */
const closingOf = (closed: T.SessionClose | undefined): { delivered: T.Delivery } | { canceled: T.IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

function failedText(findings: readonly T.Finding[], text: string): string {
  let out = t("server.issue.brief.failedHead");
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + t("server.issue.brief.failedEnd");
}

const make = Effect.gen(function* () {
  const core = yield* Core;
  const store = yield* Agent;
  const projects = yield* Project;
  const runtimes = yield* Runtime;
  const sessions = yield* Session;
  const chat = yield* Channel;
  const db = yield* Db;
  const r = yield* issueRecords;
  const {
    worked,
    reloadAssignments,
    issueOf,
    everyIssue,
    idOf,
    get,
    publish,
    unsent,
    liveSession,
    issueWords,
    add,
    complete,
    cancelAs,
    endRun,
    changesOf,
    setConflict,
    reopenRow,
    answered,
    judged,
    ownerSaid,
    queueRow,
    drop,
    place,
  } = r;
  const { split, joinChildren } = yield* issueSplitting(r);
  const d = yield* issueDispatch(r, joinChildren);
  const { hire, start, refreshQueue, reopen, scheduled } = d;
  const { withEdit, settledMove, stuckWords, movesWords } = yield* issueSettling(r, d);

  const { merge, refreshPullRequests, submit } = merging({
    core,
    sessions,
    projects,
    chat,
    db,
    get,
    list: everyIssue,
    liveSession,
    publish,
    setConflict,
  });

  const submitPullRequest = Effect.fn("Issue.submitPullRequest")(function* (session: string, summary?: string) {
    const issue = worked.issueOf(session);
    if (!issue) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    const item = yield* get(issue);
    if (latestSessionIdOf(item) !== session) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    if (item.mandate.strength !== "explicit" || !item.mandate.autoSubmitPr) return yield* Effect.fail(refused(t("server.issue.prSubmitNotAllowed")));
    if (!item.project || !projects.usesPullRequests(item.project)) return yield* Effect.fail(refused(t("server.issue.prSubmitUnavailable")));
    return yield* submit(item.id, session, summary);
  });

  const comment = Effect.fn("Issue.comment")(function* (id: string, text: string, sendKey: string = "") {
    const issue = yield* get(id);
    if (isClosed(issue.status)) return yield* Effect.fail(refused(t("server.issue.closedReopen")));
    const latest = latestSessionIdOf(issue);
    const session = latest === undefined ? undefined : sessions.sessionOf(latest);
    const thread = yield* chat.issueThread(issue.id, issue.title, session?.channel);
    yield* chat.say(text, thread, sendKey);
  });

  /** Its session, if one is on the farm, goes home; an issue no session works on has nobody to send. */
  const cancel = Effect.fn("Issue.cancel")(function* (id: string): Effect.fn.Return<void, ApiError> {
    const item = yield* get(id);
    yield* Effect.forEach(
      (yield* everyIssue).filter((child) => child.parent === item.id && !isClosed(child.status)),
      (child) =>
        Effect.gen(function* () {
          yield* cancel(child.id);
          yield* cancelAs(child.id, "dismissed");
        }),
      { discard: true },
    );
    const last = latestSessionIdOf(item);
    if (last === undefined || !sessions.present(last)) return;
    if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing(t("server.issue.helperRef", { id: last }), [lookIn.session]));
  });

  const { draft, handedBack, clearRefinement } = refinement({
    core,
    store,
    runtimes,
    sessions,
    chat,
    db,
    get,
    unsent,
    hire,
    publish,
    assignments: worked,
  });

  const onSessionNews = Effect.fn("Issue.onSessionNews")(function* (n: SessionNews) {
    switch (n._tag) {
      case "left": {
        const e = n.left;
        const issue = worked.issueOf(e.id);
        if (!issue) return;
        const row = yield* db.one(q.getIssue({ id: issue }));
        if (!row) return;
        const runs = worked.sessionIds(issue);
        // Closed already (completed by the owner before its session went home): the verdict stands.
        if (runs.at(-1) !== e.id || row.closed_at !== null) return;
        const closing = closingOf(e.closed);
        yield* db.run(
          "delivered" in closing
            ? q.completeOpenIssue({ closed_at: yield* Clock.currentTimeMillis, delivered: closing.delivered, id: issue })
            : q.cancelOpenIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: closing.canceled, id: issue }),
        );
        yield* publish(issue);
        return;
      }
      case "reported": {
        const e = n.report;
        const issue = worked.issueOf(e.id);
        // A report's 要问主人： lines are what its issue waits on the owner for; a report without them clears them.
        if (issue)
          yield* Effect.andThen(
            db.run(
              q.setIssueReport({
                id: issue,
                questions: jsonOrNull(openQuestions(e.questions), openQuestions(e.questions).length > 0),
                checks: jsonOrNull(e.checks, e.checks.length > 0),
              }),
            ),
            publish(issue),
          );
        if (issue) yield* answered(issue, e.id, e.outcome, e.answer);
        yield* handedBack(e);
        if (issue) {
          const conflict = (yield* get(issue)).conflict;
          if (conflict) yield* setConflict(issue, yield* sessions.withWorkplace(e.id, (place) => projects.conflict(place, conflict.base)));
        }
        yield* joinChildren;
        return;
      }
      case "hired":
        return;
    }
  });

  const onOwnerInThread = Effect.fn("Issue.onOwnerInThread")(function* (thread: string) {
    const issue = yield* Effect.option(get(thread));
    if (Option.isNone(issue)) return;
    const item = issue.value;
    if (isClosed(item.status)) return;
    yield* ownerSaid(item.id);
  });

  const rows = yield* db.run(q.keptIssues({ closed: keepClosedIssues }));
  yield* Effect.forEach(rows, (row) => core.apply({ type: "issueChanged", issue: issueOf(row, worked.of(row.id)) }), { discard: true });
  const news = yield* sessions.news;
  const ownerWords = yield* chat.ownerInThread;
  const finished = yield* sessions.finishedRuns;
  yield* Effect.forkScoped(
    Stream.runForEach(yield* sessions.startedIssues, (id) =>
      Effect.andThen(db.run(q.unqueueIssue({ id })), publish(id)).pipe(bestEffort(`issue: run started on ${id}`)),
    ),
  );
  // One at a time: a report and the owner's word on it do not cross.
  yield* Effect.forkScoped(
    Stream.runForEach(
      Stream.merge(
        news,
        Stream.map(ownerWords, (w) => ({ _tag: "owner" as const, thread: w.thread, message: w.message })),
      ),
      (n) =>
        n._tag === "owner"
          ? onOwnerInThread(n.thread).pipe(bestEffort(`vibevalley: issues after the owner's words in ${n.thread}`))
          : onSessionNews(n).pipe(bestEffort(`vibevalley: issues after ${n._tag}`)),
    ),
  );
  yield* Effect.forkScoped(
    // However the orchestrator's turn ended, the issue waits on the owner: a turn that did not fail is not an answer yet.
    Stream.runForEach(finished, (run) =>
      Effect.forEach(run.issues, (id) => endRun(id).pipe(bestEffort(`vibevalley: run ${run.id} finished on issue ${id}`)), {
        discard: true,
      }),
    ),
  );

  const timeline = Effect.fn("Issue.timeline")(function* (id: string) {
    const issue = yield* get(id);
    const runs = yield* sessions.issueRuns(issue.id);
    const names = new Map<string, string>();
    yield* Effect.forEach(
      new Set(runs.map((r) => r.session)),
      (s) =>
        Effect.gen(function* () {
          const found = yield* sessions.get(s);
          if (found) names.set(s, found.name);
        }),
      { discard: true },
    );
    return milestonesOf(issue, runs, names);
  });

  yield* Effect.forkScoped(
    Stream.runForEach(yield* core.subscribe, (fact) =>
      Effect.gen(function* () {
        if (fact.type !== "issueChanged" && fact.type !== "sessionLeft" && !(fact.type === "sessionChanged" && fact.session.issue !== undefined)) return;
        yield* refreshQueue();
      }).pipe(bestEffort("issue: advance queued work")),
    ),
  );

  const shape = Issue.of({
    scheduled,
    submitPullRequest,
    split,
    onBoard: () => core.state().issues,
    list: Effect.fn("Issue.list")(function* () {
      return yield* everyIssue;
    }),
    query: Effect.fn("Issue.query")(function* (f) {
      const all = yield* everyIssue;
      return pickIssues(all, f, yield* Clock.currentTimeMillis);
    }),
    get,
    timeline,
    add: Effect.fn("Issue.add")(function* (req, mandate) {
      return yield* add(req, mandate);
    }),
    /** The words and who does it only before it is sent; how it is accepted and what it delivers while it is open: the
     * next round goes by them. */
    edit: Effect.fn("Issue.edit")(function* (id, upd, by) {
      if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      const whileOpen =
        upd.title === undefined &&
        upd.description === undefined &&
        upd.project === undefined &&
        upd.agent === undefined &&
        upd.priority === undefined &&
        upd.criteria === undefined &&
        upd.before === undefined;
      let was: T.Issue;
      if (whileOpen) {
        was = yield* get(id);
        if (isClosed(was.status)) return yield* Effect.fail(refused(t("server.issue.closed")));
      } else was = yield* unsent(id);
      const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description });
      if (upd.project !== undefined && upd.project !== was.project && was.project) {
        const released = yield* sessions.clearWorkplace(was.id, was.project, was.number, "preserve");
        if (released.kept) return yield* Effect.fail(refused(t("server.issue.cannotMoveProject", { n: was.number, why: released.reason })));
      }
      const criteria = upd.criteria !== undefined ? kept(upd.criteria) : was.criteria;
      const agent = upd.agent ?? assignedAgentOf(was);
      const at = yield* Clock.currentTimeMillis;
      const assignment = yield* db.run(
        db.attemptTx(
          Effect.gen(function* () {
            yield* q.editIssue({
              title,
              description,
              project: nullText(upd.project ?? was.project),
              priority: upd.priority ?? was.priority,
              criteria: jsonOrNull(criteria, criteria.length > 0),
              deliver: upd.deliver ?? was.deliver,
              id,
            });
            return yield* assignTo(id, agent, at);
          }),
        ),
      );
      worked.changed(assignment.changed);
      if (upd.before !== undefined) yield* place(id, upd.before);
      else yield* publish(id);
      return yield* get(id);
    }),
    remove: Effect.fn("Issue.remove")(function* (id) {
      const item = yield* unsent(id);
      const cleared = yield* clearRefinement(item);
      if (cleared.kept) return yield* Effect.fail(refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason })));
      yield* db.run(q.removeIssue({ id }));
      yield* reloadAssignments;
      yield* core.apply({ type: "issueRemoved", id: issueId(id) });
    }),
    // Untraced: it only drops the arguments the service does not take, and the call it makes is named Issue.start.
    start: Effect.fnUntraced(function* (id, channel) {
      return yield* start(id, channel);
    }),
    idOf,
    stop: Effect.fn("Issue.stop")(function* (id) {
      yield* sessions.stop(yield* liveSession(id));
    }),
    setStatus: Effect.fn("Issue.setStatus")(function* (ref, to, text, channel, by, opt = {}) {
      if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      const item = yield* get(ref);
      // Read by its number too: every write below goes by its id.
      const id = item.id;
      const { move, said, taker, delivery } = yield* settledMove(item, to, text, opt);
      switch (move) {
        case "start":
          if (taker) yield* shape.edit(id, { agent: taker.id }, by);
          yield* start(id, channel);
          break;
        case "unqueue":
          yield* queueRow(id, false, chat.defaultChannel());
          break;
        // Handed over: its session leaves first, so that one session at a time works the issue's branch.
        case "round":
          if (taker) {
            yield* cancel(id);
            yield* cancelAs(id, "dismissed");
            yield* reopen(id, said, channel, { kind: "comment" }, taker);
            break;
          }
          // A session on the farm hears it in its thread; with none (the orchestrator's), its doer is asked again. While it
          // waits for acceptance the words are the findings, written down and given as the next round's brief.
          if (sessionIdsOf(item).length === 0) yield* start(id, channel, { kind: "comment" }, said);
          else if (said && item.stage.state === "reviewing") yield* shape.review(id, { pass: false, findings: findingsOf(said) });
          else yield* comment(id, said || (yield* stuckWords(item)));
          break;
        case "reopen":
          yield* reopen(id, said, channel, { kind: "comment" }, taker);
          break;
        case "revive":
          yield* reopenRow(id);
          break;
        // What it delivers follows the issue: nothing to take in (no commits), or its branch kept by the owner's choice,
        // touches no git and opens no pull request; the rest is merged into the main branch or by a pull request.
        case "complete": {
          // Completing is the acceptance: whatever it was sent back for is settled.
          const unresolved = item.findings.some((f) => !f.resolved);
          const settleFindings = () =>
            judged(
              id,
              item.reviewedAt ?? 0,
              item.findings.map((f) => ({ ...f, resolved: true })),
            );
          if (delivery === "kept" || delivery === "none") {
            if (unresolved) yield* settleFindings();
            // Written down before its session goes home, so that leaving does not take it for canceled.
            yield* complete(id, delivery);
            const last = latestSessionIdOf(item);
            if (last !== undefined && sessions.present(last)) yield* sessions.dismiss(last, "keep", "completed");
            break;
          }
          // The session's leaving closes the issue too, but later: closed here, the answer already says so.
          // Merge before settling the findings: settling them republishes the issue, and merge checks the table again.
          yield* merge(id, true);
          const updated = yield* get(id);
          if (updated.pullRequest?.state !== "open") {
            yield* complete(id, updated.pullRequest ? "pull_request" : "merged");
          }
          if (unresolved) yield* settleFindings();
          break;
        }
        case "cancel":
          yield* cancel(id);
          yield* cancelAs(id, "dismissed");
          break;
        case "drop":
          yield* cancel(id);
          yield* clearRefinement(item);
          yield* drop(id);
          break;
      }
      return yield* get(id);
    }),
    previewStatus: Effect.fn("Issue.previewStatus")(function* (id, to, text, opt = {}, edit) {
      const item = yield* withEdit(yield* get(id), edit);
      return { does: yield* movesWords(yield* settledMove(item, to, text, opt)) };
    }),
    previewRemove: Effect.fn("Issue.previewRemove")(function* (id) {
      const item = yield* unsent(id);
      return {
        does: [
          t("server.issue.does.deleteIssue", { n: item.number, title: shortTitle(item.title) }),
          ...(item.refining ? [t("server.issue.does.drafterLeaves", { name: item.refining.name })] : []),
          ...(item.project ? [t("server.issue.does.cleanWorktree")] : []),
        ],
      };
    }),
    comment,
    changes: Effect.fn("Issue.changes")(function* (id, by) {
      const item = yield* get(id);
      const changes = yield* changesOf(item);
      if (!changes) return yield* Effect.fail(refused(t("server.issue.notStarted")));
      yield* setConflict(id, conflictOf(changes));
      const session = latestSessionIdOf(item);
      if (by.kind === "owner" && session && sessions.present(session)) yield* core.did({ kind: "reviewed", session });
      return changes;
    }),
    review: Effect.fn("Issue.review")(function* (id, req) {
      const item = yield* get(id);
      const why = isForOrchestrator(item, store.isOrchestrator)
        ? t("server.issue.orchestratorAnswers")
        : item.status !== "in_review"
          ? t("server.issue.nothingToAccept")
          : "";
      if (why) return yield* Effect.fail(refused(why, nextSteps(item)));
      if (req.pass) {
        yield* judged(
          id,
          yield* Clock.currentTimeMillis,
          item.findings.map((f) => ({ ...f, resolved: true })),
        );
        return yield* get(id);
      }
      const fresh = kept(req.findings);
      const text = (req.text ?? "").trim();
      if (fresh.length === 0 && !text) return yield* Effect.fail(refused(t("server.issue.failNeedsFindings")));
      const at = yield* Clock.currentTimeMillis;
      const findings = [...item.findings, ...fresh.map((text) => ({ id: newId(), text, at, resolved: false }))];
      yield* judged(id, 0, findings);
      // The findings go to whoever works it as the next round's words, like any comment.
      yield* comment(id, failedText(findings, text));
      return yield* get(id);
    }),
    refine: draft,
    /** A session with no record is named as missing, not given a phase. */
    history: Effect.fn("Issue.history")(function* () {
      const all = yield* everyIssue;
      const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
      return all.map((issue) => ({
        issue,
        sessions: sessionIdsOf(issue).flatMap((id) => {
          const s = byId.get(id);
          return s ? [s] : [];
        }),
        missingSessions: sessionIdsOf(issue).filter((id) => !byId.has(id)),
      }));
    }),
    templates: Effect.fn("Issue.templates")(function* (name) {
      const stack = yield* projects.stack(name);
      if (!stack) return yield* Effect.fail(missing(t("server.issue.projectRef", { name }), [lookIn.project]));
      return { project: name, stack, recent: sentTitles(yield* everyIssue, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
    }),
    hire,
    refreshPullRequests,
    refreshQueue: refreshQueue(),
  });
  return shape;
});

/** The queue and the pull requests are looked at again on their periods once every service is built. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const issue = yield* Issue;
    yield* issue.refreshQueue;
    yield* Effect.forkScoped(issue.refreshQueue.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
    // Each waits a period before its first run, then runs every period.
    const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(
      issue.refreshPullRequests.pipe(bestEffort("vibevalley: refresh pull requests"), Effect.repeat(Schedule.spaced(pollEvery)), Effect.delay(pollEvery)),
    );
  }),
);
