import { Clock, Context, Effect, Layer, Option, Schedule, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf, shortTitle } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { templateCatalog } from "#/agent/seed.ts";
import { actsForOwner, type Actor } from "#/base/actor.ts";
import { type ApiError, missing, lookIn, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import type { Due } from "#/cron/cron.ts";
import { ServerConfig } from "#/infra/config.ts";
import { bestEffort } from "#/infra/log.ts";
import { Repo } from "#/repo/repo.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { type Hired, type HireOptions, type SessionNews, Session } from "#/session/session.ts";

import { findingsOf, milestonesOf } from "./brief.ts";
import { filledKinds, sentTitles } from "./creation.ts";
import { type Dispatched, issueDispatch } from "./dispatch.ts";
import { issueLifecycle } from "./lifecycle.ts";
import { merging } from "./merge.ts";
import { nextSteps } from "./moves.ts";
import { needsOwner } from "./prompts.ts";
import { kept, refinement } from "./refinement.ts";
import { issueSettling, type StatusOptions } from "./settle.ts";
import { issueSplitting } from "./split.ts";
import { conflictOf, isClosed, assignedOnDuty, pickIssues } from "./status.ts";

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
    /** agent: moving to todo, the profile (id or name) that takes it on. another than its own hands it over. */
    readonly setStatus: (id: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Effect.Effect<T.Issue, ApiError>;
    /** Stops the turn of the session working it; the session stays, and a word starts the next. */
    readonly stop: (id: string) => Effect.Effect<void, ApiError>;
    /** What setStatus would do with the same request, refused as it would be. nothing changes. */
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
    readonly templates: (repo: string) => Effect.Effect<T.RepoTemplates, ApiError>;
    /** Sends a session for work that is not written down first (the orchestrator sending someone at once, a task's step): its issue is made from the brief. */
    readonly hire: (agent: T.Agent, brief: string, repo: string, opt?: HireOptions) => Effect.Effect<Hired>;
    readonly refreshPullRequests: Effect.Effect<void>;
    readonly refreshQueue: Effect.Effect<void>;
    readonly submitPullRequest: (session: string, summary?: string) => Effect.Effect<string, ApiError>;
  }
>()("@vibevalley/server/issue/issue") {
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
  const repos = yield* Repo;
  const runtimes = yield* Runtime;
  const sessions = yield* Session;
  const chat = yield* Channel;
  const r = yield* issueLifecycle;
  const {
    worked,
    loadKept,
    everyIssue,
    idOf,
    get,
    unsent,
    liveSession,
    issueWords,
    add,
    remove,
    saveEdit,
    complete,
    cancelAs,
    closeIfOpen,
    endRun,
    changesOf,
    setConflict,
    revive,
    unqueue,
    recordReport,
    judged,
    ownerSaid,
    setQueued,
    drop,
    savePullRequest,
    finishPullRequest,
  } = r;
  const { split, joinChildren } = yield* issueSplitting(r);
  const d = yield* issueDispatch(r, joinChildren);
  const { hire, start, refreshQueue, reopen, scheduled } = d;
  const { withEdit, settledMove, stuckWords, movesWords } = yield* issueSettling(r, d);

  const { merge, refreshPullRequests, submit } = merging({
    core,
    sessions,
    repos,
    chat,
    get,
    list: everyIssue,
    liveSession,
    setConflict,
    savePullRequest,
    finishPullRequest,
  });

  const submitPullRequest = Effect.fn("Issue.submitPullRequest")(function* (session: string, summary?: string) {
    const issue = worked.issueOf(session);
    if (!issue) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    const item = yield* get(issue);
    if (latestSessionIdOf(item) !== session) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    if (item.mandate.strength !== "explicit" || !item.mandate.autoSubmitPr) return yield* Effect.fail(refused(t("server.issue.prSubmitNotAllowed")));
    if (!item.repo || !repos.usesPullRequests(item.repo)) return yield* Effect.fail(refused(t("server.issue.prSubmitUnavailable")));
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
    if (last === undefined || !sessions.isReachable(last)) return;
    if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing(t("server.issue.helperRef", { id: last }), [lookIn.session]));
  });

  const { draft, handedBack, clearRefinement } = refinement({
    core,
    store,
    runtimes,
    sessions,
    chat,
    get,
    unsent,
    hire,
    lastAssigneeIn: r.lastAssigneeIn,
    saveEdit,
    saveRefinement: r.saveRefinement,
  });

  const onSessionNews = Effect.fn("Issue.onSessionNews")(function* (n: SessionNews) {
    switch (n._tag) {
      case "Left":
        yield* closeIfOpen(n.left.id, n.left.closed);
        return;
      case "Reported": {
        const e = n.report;
        const issue = yield* recordReport(e.id, e.outcome, e.questions, e.checks, e.answer);
        yield* handedBack(e);
        if (issue) {
          const conflict = (yield* get(issue)).conflict;
          if (conflict) {
            const rechecked = yield* sessions.withWorkplace(e.id, (place) => repos.conflict(place, conflict.base));
            yield* setConflict(issue, rechecked);
          }
        }
        yield* joinChildren();
        return;
      }
      case "IssueStarted":
        yield* unqueue(n.issue);
        return;
      case "RunFinished":
        // However the orchestrator's turn ended, the issue waits on the owner: a turn that did not fail is not an answer yet.
        yield* Effect.forEach(n.issues, (id) => endRun(id).pipe(bestEffort(`vibevalley: run ${n.id} finished on issue ${id}`)), { discard: true });
        return;
      default:
        // A hire is the channels' to follow; inputs and launches are Mailbox's.
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

  yield* loadKept;
  const news = yield* sessions.news;
  const ownerWords = yield* chat.ownerInThread;
  // One at a time: a report and the owner's word on it do not cross.
  yield* Effect.forkScoped(
    Stream.runForEach(
      Stream.merge(
        news,
        Stream.map(ownerWords, (w) => ({ _tag: "OwnerSaid" as const, thread: w.thread, message: w.message })),
      ),
      (n) =>
        n._tag === "OwnerSaid"
          ? onOwnerInThread(n.thread).pipe(bestEffort(`vibevalley: issues after the owner's words in ${n.thread}`))
          : onSessionNews(n).pipe(bestEffort(`vibevalley: issues after ${n._tag}`)),
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

  const subscribe2 = yield* core.subscribe;
  yield* Effect.forkScoped(
    Stream.runForEach(subscribe2, (fact) =>
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
      const now = yield* Clock.currentTimeMillis;
      return pickIssues(all, f, now);
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
        upd.repo === undefined &&
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
      if (upd.repo !== undefined && upd.repo !== was.repo && was.repo) {
        const released = yield* sessions.clearWorkplace(was.id, was.repo, was.number, "preserve");
        if (released.kept) return yield* Effect.fail(refused(t("server.issue.cannotMoveRepo", { n: was.number, why: released.reason })));
      }
      const criteria = upd.criteria !== undefined ? kept(upd.criteria) : was.criteria;
      const agent = upd.agent ?? assignedAgentOf(was);
      yield* saveEdit(id, {
        title,
        description,
        repo: upd.repo ?? was.repo,
        priority: upd.priority ?? was.priority,
        criteria,
        deliver: upd.deliver ?? was.deliver,
        agent,
        ...(upd.before !== undefined ? { before: upd.before } : {}),
      });
      return yield* get(id);
    }),
    remove: Effect.fn("Issue.remove")(function* (id) {
      const item = yield* unsent(id);
      const cleared = yield* clearRefinement(item);
      if (cleared.kept) return yield* Effect.fail(refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason })));
      yield* remove(id);
    }),
    // Untraced: it only drops the arguments the service does not take, and the call it makes is named Issue.start.
    start: Effect.fnUntraced(function* (id, channel) {
      return yield* start(id, channel);
    }),
    idOf,
    stop: Effect.fn("Issue.stop")(function* (id) {
      const liveSession2 = yield* liveSession(id);
      yield* sessions.stop(liveSession2);
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
          const issueThread2 = yield* chat.issueThread(id, item.title, channel || undefined);
          yield* chat.notice(
            issueThread2,
            t("server.issue.confirmedRequirements", { title: item.title, description: item.description, criteria: item.criteria.join("\n") }),
            "issue_confirmed",
          );
          break;
        case "unqueue":
          yield* setQueued(id, false, chat.defaultChannel());
          break;
        // Handed over: its session leaves first, so that one session at a time works the issue's branch.
        case "round":
          if (taker) {
            yield* cancel(id);
            yield* cancelAs(id, "dismissed");
            yield* reopen(id, said, channel, { kind: "comment" }, taker);
            break;
          }
          // A session on the farm hears it in its thread. with none (the orchestrator's), its doer is asked again.
          if (sessionIdsOf(item).length === 0) yield* start(id, channel, { kind: "comment" }, said);
          else if (said && item.stage.state === "reviewing") yield* shape.review(id, { pass: false, findings: findingsOf(said) });
          else yield* comment(id, said || (yield* stuckWords(item)));
          break;
        case "reopen":
          yield* reopen(id, said, channel, { kind: "comment" }, taker);
          break;
        case "revive":
          yield* revive(id);
          break;
        // What it delivers follows the issue: nothing to take in (no commits), or its branch kept by the owner's choice, touches no git and opens no pull request.
        case "complete": {
          // Completing is the acceptance: whatever it was sent back for is settled.
          const unresolved = item.findings.some((f) => !f.resolved);
          const settleFindings = () =>
            judged(
              id,
              item.reviewedAt ?? 0,
              item.findings.map((f) => ({ ...f, resolved: true })),
            );
          if (delivery === "submit") yield* merge(id, true);
          const acceptedDelivery = delivery === "submit" ? "submitted" : delivery;
          if (acceptedDelivery === "kept" || acceptedDelivery === "none" || acceptedDelivery === "submitted") {
            if (unresolved) yield* settleFindings();
            // Written down before its session goes home, so that leaving does not take it for canceled.
            yield* complete(id, acceptedDelivery);
            const last = latestSessionIdOf(item);
            if (last !== undefined && sessions.isReachable(last)) yield* sessions.dismiss(last, "keep", "completed");
            break;
          }
          // The session's leaving closes the issue too, but later: closed here, the answer already says so.
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
      const found = yield* get(id);
      const item = yield* withEdit(found, edit);
      const move = yield* settledMove(item, to, text, opt);
      const does = yield* movesWords(move);
      return { does };
    }),
    previewRemove: Effect.fn("Issue.previewRemove")(function* (id) {
      const item = yield* unsent(id);
      return {
        does: [
          t("server.issue.does.deleteIssue", { n: item.number, title: shortTitle(item.title) }),
          ...(item.refining ? [t("server.issue.does.drafterLeaves", { name: item.refining.name })] : []),
          ...(item.repo ? [t("server.issue.does.cleanWorktree")] : []),
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
      if (by.kind === "owner" && session && sessions.isReachable(session)) yield* core.did({ kind: "reviewed", session });
      return changes;
    }),
    review: Effect.fn("Issue.review")(function* (id, req) {
      const item = yield* get(id);
      const why = assignedOnDuty(item, store.isOrchestrator)
        ? t("server.issue.orchestratorAnswers")
        : item.status !== "in_review"
          ? t("server.issue.nothingToAccept")
          : "";
      if (why) return yield* Effect.fail(refused(why, nextSteps(item)));
      if (req.pass) {
        const now = yield* Clock.currentTimeMillis;
        yield* judged(
          id,
          now,
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
      const stack = yield* repos.stack(name);
      if (!stack) return yield* Effect.fail(missing(t("server.issue.repoRef", { name }), [lookIn.repo]));
      const all = yield* everyIssue;
      return { repo: name, stack, recent: sentTitles(all, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
    }),
    hire,
    refreshPullRequests: refreshPullRequests(),
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
