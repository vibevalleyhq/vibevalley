import { Clock, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { assignedAgentOf, latestSessionIdOf, sessionIdsOf, shortTitle } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { actsForUser, type Actor, user as userActor } from "#/base/actor.ts";
import { type ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { bestEffort } from "#/infra/log.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { templateCatalog } from "#/modules/agent/seed.ts";
import { Channel } from "#/modules/channel/channel.ts";
import type { Due } from "#/modules/cron/cron.ts";
import type { Trigger } from "#/modules/mailbox/shapes.ts";
import { Repo } from "#/modules/repo/repo.ts";
import { Runtime } from "#/modules/runtime/runtime.ts";
import { type Hired, type HireOptions, type HireRefused, type SessionNews, Session } from "#/modules/session/session.ts";

import { findingsOf, milestonesOf } from "./brief.ts";
import { explicitMandate, filledKinds, inferredMandate, mandateNoteFits, sentTitles } from "./creation.ts";
import { type Dispatched, issueDispatch } from "./dispatch.ts";
import { makeGitHubPoller } from "./github.ts";
import { issueLifecycle } from "./lifecycle.ts";
import { merging } from "./merge.ts";
import { nextSteps } from "./moves.ts";
import { needsUser } from "./prompts.ts";
import { kept, refinement } from "./refinement.ts";
import { issueSettling, type StatusOptions } from "./settle.ts";
import { issueSplitting } from "./split.ts";
import { conflictOf, isClosed, assignedOnDuty, pickIssues } from "./status.ts";

const refused = refuseIn(BizCode.IssueRefused);

export class AgentChoiceRefused extends Schema.TaggedError<AgentChoiceRefused, { readonly brand: unique symbol }>()("AgentChoiceRefused", {
  kind: Schema.Literals(["noneAvailable", "notFound"]),
  key: Schema.String,
}) {}

export class IssueCreateRefused extends Schema.TaggedError<IssueCreateRefused, { readonly brand: unique symbol }>()("IssueCreateRefused", {
  reason: Schema.Literals(["draftWithStart", "noteTooLong", "noChannel", "noDefaultRepo", "agentChoice", "notRecorded"]),
  channel: Schema.optionalKey(Schema.String),
  choice: Schema.optionalKey(AgentChoiceRefused),
  error: Schema.optionalKey(ApiErrorSchema),
}) {}

export interface IssueCreateInput {
  readonly title: string;
  readonly parent?: string;
  readonly blockedBy?: readonly string[];
  readonly constraints?: T.IssueConstraints;
  readonly description?: string;
  readonly repo?: string;
  readonly agent?: string;
  readonly priority?: T.Priority;
  readonly deliver?: T.Deliverable;
  readonly criteria?: readonly string[];
  readonly autoSubmitPr?: boolean;
  readonly by: Actor;
  readonly envelope?: string;
  /** Channel name when `channelByName` is true; otherwise channel or thread id (defaults to farm default channel). */
  readonly channel?: string;
  readonly channelByName?: boolean;
  readonly pickedAgent?: string;
  readonly chooseAgent?: boolean;
  readonly enforceNoteLimit?: boolean;
  readonly start?: boolean;
  readonly draft?: boolean;
}

export type IssueCreateStep =
  | { readonly _tag: "Backlog" }
  | {
      readonly _tag: "Dispatched";
      readonly channelName: string;
      readonly repo: string;
      readonly queued?: string;
      readonly session?: T.Session;
    }
  | { readonly _tag: "StartFailed"; readonly error: ApiError }
  | { readonly _tag: "Drafting" }
  | { readonly _tag: "DraftFailed"; readonly error: ApiError };

export interface IssueCreated {
  readonly issue: T.Issue;
  readonly step: IssueCreateStep;
}

export interface CommentReceipt {
  readonly thread?: string;
  readonly worker?: T.Session;
}

export class Issue extends Context.Service<
  Issue,
  {
    readonly list: () => Effect.Effect<T.Issue[]>;
    readonly query: (f: T.IssueFilter) => Effect.Effect<T.Issue[]>;
    readonly onBoard: () => readonly T.Issue[];
    readonly get: (id: string) => Effect.Effect<T.Issue, ApiError>;
    readonly add: (req: T.IssueRequest, mandate: T.IssueMandate) => Effect.Effect<T.Issue, ApiError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreated, ApiError | IssueCreateRefused>;
    readonly chooseAgent: (brief: string, name: string, picked: string) => Effect.Effect<T.Agent, AgentChoiceRefused>;
    readonly edit: (id: string, upd: T.IssueUpdate, by: Actor) => Effect.Effect<T.Issue, ApiError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
    readonly scheduled: (due: Due, input: Trigger) => Effect.Effect<T.Issue, ApiError>;
    readonly split: (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) => Effect.Effect<string, ApiError>;
    readonly setStatus: (id: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Effect.Effect<T.Issue, ApiError>;
    readonly stop: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewStatus: (id: string, to: T.IssueStatus, text: string, opt?: StatusOptions, edit?: T.IssueUpdate) => Effect.Effect<T.Preview, ApiError>;
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** Resolves `#41`, `41`, an issue id, or the name or id of a helper or session that worked it. */
    readonly idOf: (ref: string) => Effect.Effect<string, ApiError>;
    readonly comment: (id: string, text: string, sendKey?: string, by?: Actor) => Effect.Effect<CommentReceipt, ApiError>;
    readonly changes: (id: string, by: Actor) => Effect.Effect<T.Changes, ApiError>;
    readonly review: (id: string, req: IssueReviewRequest) => Effect.Effect<T.Issue, ApiError>;
    readonly refine: (id: string, word: string, channel: string) => Effect.Effect<T.Issue, ApiError>;
    readonly history: () => Effect.Effect<T.IssueHistory[]>;
    readonly timeline: (id: string) => Effect.Effect<T.IssueTimeline, ApiError>;
    readonly templates: (repo: string) => Effect.Effect<T.RepoTemplates, ApiError>;
    readonly hire: (agent: T.Agent, brief: string, repo: string, opt?: HireOptions) => Effect.Effect<Hired, HireRefused>;
    readonly pollGitHub: Effect.Effect<void>;
    readonly refreshPullRequests: Effect.Effect<void>;
    readonly refreshQueue: Effect.Effect<void>;
    readonly submitPullRequest: (session: string, summary?: string) => Effect.Effect<string, ApiError>;
  }
>()("@vibevalley/server/modules/issue/issue") {
  static readonly layer = Layer.effect(
    Issue,
    Effect.suspend(() => make),
  );
}

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
    issueOfSession,
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
    userSaid,
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
  const { pollOpen: pollGitHub } = yield* makeGitHubPoller(() => core.state().issues);

  const chooseAgent = Effect.fn("Issue.chooseAgent")(function* (brief: string, name: string, picked: string): Effect.fn.Return<T.Agent, AgentChoiceRefused> {
    const key = name.trim();
    const chosen = yield* runtimes.choose(brief, key, picked);
    if (!chosen) return yield* AgentChoiceRefused.make({ kind: "noneAvailable", key });
    if (key && chosen.id !== key && chosen.name !== key && chosen.runtime !== key) {
      return yield* AgentChoiceRefused.make({ kind: "notFound", key });
    }
    return chosen;
  });

  const submitPullRequest = Effect.fn("Issue.submitPullRequest")(function* (session: string, summary?: string) {
    const issue = issueOfSession(session);
    if (!issue) return yield* refused(t("server.issue.prSubmitNotCurrent"));
    const item = yield* get(issue);
    if (latestSessionIdOf(item) !== session) return yield* refused(t("server.issue.prSubmitNotCurrent"));
    if (item.mandate.strength !== "explicit" || !item.mandate.autoSubmitPr) return yield* refused(t("server.issue.prSubmitNotAllowed"));
    if (!item.repo || !repos.usesPullRequests(item.repo)) return yield* refused(t("server.issue.prSubmitUnavailable"));
    return yield* submit(item.id, session, summary);
  });

  const comment = Effect.fn("Issue.comment")(function* (
    id: string,
    text: string,
    sendKey: string = "",
    by: Actor = userActor,
  ): Effect.fn.Return<CommentReceipt, ApiError> {
    const issue = yield* get(id);
    const latest = latestSessionIdOf(issue);
    const session = latest === undefined ? undefined : sessions.sessionOf(latest);
    if (by.kind === "agent") {
      if (!session) return {};
      yield* chat.post({ _tag: "Tell", from: by.id, session: session.id, text, sendKey });
      return { worker: session };
    }
    if (isClosed(issue.status)) return yield* refused(t("server.issue.closedReopen"));
    const thread = yield* chat.issueThread(issue.id, issue.title, session?.channel);
    yield* chat.post({ _tag: "User", text: text, channel: thread, sendKey: sendKey });
    return { thread, ...(session ? { worker: session } : {}) };
  });

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
    if (!(yield* sessions.dismiss(last))) return yield* missing(t("server.issue.helperRef", { id: last }), [lookIn.session]);
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

  const create = Effect.fn("Issue.create")(function* (input: IssueCreateInput): Effect.fn.Return<IssueCreated, ApiError | IssueCreateRefused> {
    if (input.draft === true && input.start === true) return yield* IssueCreateRefused.make({ reason: "draftWithStart" });
    if (input.enforceNoteLimit === true && !mandateNoteFits(input.description ?? "")) {
      return yield* IssueCreateRefused.make({ reason: "noteTooLong" });
    }
    let channel;
    if (input.channelByName === true && input.channel) {
      const byName = yield* chat.channelByName(input.channel);
      if (!byName) return yield* IssueCreateRefused.make({ reason: "noChannel", channel: input.channel });
      channel = byName;
    } else {
      channel = yield* chat.topOf(input.channel || chat.defaultChannel());
    }
    let parent: T.Issue | undefined;
    if (input.parent) {
      const parentId = yield* idOf(input.parent);
      parent = yield* get(parentId);
    }
    const blockedBy = yield* Effect.forEach(input.blockedBy ?? [], (ref) => Effect.map(idOf(ref), issueId));
    const repo = (input.repo ?? parent?.repo ?? "").trim() || channel.repo;
    if (input.start === true && !repo) return yield* IssueCreateRefused.make({ reason: "noDefaultRepo", channel: channel.name });
    let agent: string | undefined = parent ? assignedAgentOf(parent) : undefined;
    if (input.chooseAgent === true) {
      const chosen = yield* chooseAgent(
        input.title + "\n" + (input.description ?? ""),
        input.agent ?? agent ?? "",
        input.start === true ? (input.pickedAgent ?? "") : "",
      ).pipe(Effect.mapError((choice) => IssueCreateRefused.make({ reason: "agentChoice", choice })));
      agent = chosen.id;
    } else if (input.agent !== undefined) {
      const trimmed = input.agent.trim();
      agent = trimmed ? (store.named(trimmed)?.id ?? trimmed) : trimmed;
    }
    const mandate = actsForUser(input.by) ? explicitMandate(input.envelope ?? "", input.autoSubmitPr ?? false) : inferredMandate(input.envelope ?? "");
    const item = yield* add(
      {
        title: input.title,
        ...(parent ? { parent: parent.id } : {}),
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(repo ? { repo } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.deliver ? { deliver: input.deliver } : {}),
        ...(input.criteria ? { criteria: [...input.criteria] } : {}),
      },
      mandate,
    ).pipe(Effect.mapError((error) => IssueCreateRefused.make({ reason: "notRecorded", error })));
    if (input.start === true) {
      return yield* start(item.id, channel.id).pipe(
        Effect.match({
          onFailure: (error): IssueCreated => ({ issue: item, step: { _tag: "StartFailed", error } }),
          onSuccess: (sent): IssueCreated => {
            const h = sent.session ? sessions.sessionOf(sent.session) : undefined;
            return {
              issue: item,
              step: {
                _tag: "Dispatched",
                channelName: channel.name,
                repo: h?.repo ?? repo,
                ...(sent.queued ? { queued: sent.queued } : {}),
                ...(h ? { session: h } : {}),
              },
            };
          },
        }),
      );
    }
    if (input.draft === true) {
      return yield* draft(item.id, [input.title, input.description ?? ""].join("\n").trim(), channel.id).pipe(
        Effect.match({
          onFailure: (error): IssueCreated => ({ issue: item, step: { _tag: "DraftFailed", error } }),
          onSuccess: (updated): IssueCreated => ({ issue: updated, step: { _tag: "Drafting" } }),
        }),
      );
    }
    return { issue: item, step: { _tag: "Backlog" } };
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
        // In-process orchestrator runs emit no `Reported`; move their issues to await user review when the turn ends.
        yield* Effect.forEach(n.issues, (id) => endRun(id).pipe(bestEffort(`vibevalley: run ${n.id} finished on issue ${id}`)), { discard: true });
        return;
      default:
        return;
    }
  });

  const onUserInThread = Effect.fn("Issue.onUserInThread")(function* (thread: string) {
    const issue = yield* Effect.option(get(thread));
    if (Option.isNone(issue)) return;
    const item = issue.value;
    if (isClosed(item.status)) return;
    yield* userSaid(item.id);
  });

  yield* loadKept;
  const news = yield* sessions.news;
  const userWords = yield* chat.userInThread;
  // Serialize session reports and user thread replies on one stream so they cannot race.
  yield* Effect.forkScoped(
    Stream.runForEach(
      Stream.merge(
        news,
        Stream.map(userWords, (w) => ({ _tag: "UserSaid" as const, thread: w.thread, message: w.message })),
      ),
      (n) =>
        n._tag === "UserSaid"
          ? onUserInThread(n.thread).pipe(bestEffort(`vibevalley: issues after the user's words in ${n.thread}`))
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
    create,
    chooseAgent,
    /** Only `deliver` may change after dispatch; all other fields require `unsent`. */
    edit: Effect.fn("Issue.edit")(function* (id, upd, by) {
      if (!actsForUser(by)) return yield* refused(needsUser);
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
        if (isClosed(was.status)) return yield* refused(t("server.issue.closed"));
      } else was = yield* unsent(id);
      const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description });
      if (upd.repo !== undefined && upd.repo !== was.repo && was.repo) {
        const released = yield* sessions.clearWorkplace(was.id, was.repo, was.number, "preserve");
        if (released.kept) return yield* refused(t("server.issue.cannotMoveRepo", { n: was.number, why: released.reason }));
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
      if (cleared.kept) return yield* refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason }));
      yield* remove(id);
    }),
    start: Effect.fnUntraced(function* (id, channel) {
      return yield* start(id, channel);
    }),
    idOf,
    stop: Effect.fn("Issue.stop")(function* (id) {
      const liveSession2 = yield* liveSession(id);
      yield* sessions.stop(liveSession2);
    }),
    setStatus: Effect.fn("Issue.setStatus")(function* (ref, to, text, channel, by, opt = {}) {
      if (!actsForUser(by)) return yield* refused(needsUser);
      const item = yield* get(ref);
      const id = item.id;
      const { move, said, taker, delivery } = yield* settledMove(item, to, text, opt);
      switch (move) {
        case "start":
          if (taker) yield* shape.edit(id, { agent: taker.id }, by);
          yield* start(id, channel);
          const issueThread2 = yield* chat.issueThread(id, item.title, channel || undefined);
          yield* chat.post({
            _tag: "Notice",
            channel: issueThread2,
            text: t("server.issue.confirmedRequirements", { title: item.title, description: item.description, criteria: item.criteria.join("\n") }),
            code: "issue_confirmed",
          });
          break;
        case "unqueue":
          yield* setQueued(id, false, chat.defaultChannel());
          break;
        case "round":
          if (taker) {
            // Dismiss the current helper first so at most one session owns the issue's branch.
            yield* cancel(id);
            yield* cancelAs(id, "dismissed");
            yield* reopen(id, said, channel, { kind: "comment" }, taker);
            break;
          }
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
        case "complete": {
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
            // Record completion before dismissing the helper so `Left` does not mark the issue canceled.
            yield* complete(id, acceptedDelivery);
            const last = latestSessionIdOf(item);
            if (last !== undefined && sessions.isReachable(last)) yield* sessions.dismiss(last, "keep", "completed");
            break;
          }
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
      if (!changes) return yield* refused(t("server.issue.notStarted"));
      yield* setConflict(id, conflictOf(changes));
      const session = latestSessionIdOf(item);
      if (by.kind === "user" && session && sessions.isReachable(session)) yield* core.did({ kind: "reviewed", session });
      return changes;
    }),
    review: Effect.fn("Issue.review")(function* (id, req) {
      const item = yield* get(id);
      const why = assignedOnDuty(item, store.isOrchestrator)
        ? t("server.issue.orchestratorAnswers")
        : item.status !== "in_review"
          ? t("server.issue.nothingToAccept")
          : "";
      if (why) return yield* refused(why, nextSteps(item));
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
      if (fresh.length === 0 && !text) return yield* refused(t("server.issue.failNeedsFindings"));
      const at = yield* Clock.currentTimeMillis;
      const findings = [...item.findings, ...fresh.map((text) => ({ id: newId(), text, at, resolved: false }))];
      yield* judged(id, 0, findings);
      yield* comment(id, failedText(findings, text));
      return yield* get(id);
    }),
    refine: draft,
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
      if (!stack) return yield* missing(t("server.issue.repoRef", { name }), [lookIn.repo]);
      const all = yield* everyIssue;
      return { repo: name, stack, recent: sentTitles(all, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
    }),
    hire,
    pollGitHub,
    refreshPullRequests: refreshPullRequests(),
    refreshQueue: refreshQueue(),
  });
  return shape;
});

export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const issue = yield* Issue;
    yield* issue.refreshQueue;
    yield* Effect.forkScoped(issue.refreshQueue.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
    const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(
      Effect.all([issue.refreshPullRequests.pipe(bestEffort("vibevalley: refresh pull requests")), issue.pollGitHub], { discard: true }).pipe(
        Effect.repeat(Schedule.spaced(pollEvery)),
        Effect.delay(pollEvery),
      ),
    );
  }),
);
