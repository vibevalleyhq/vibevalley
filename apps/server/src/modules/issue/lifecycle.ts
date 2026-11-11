import { Clock, Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import { Core } from "#/core/core.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Mailbox } from "#/modules/mailbox/mailbox.ts";
import type { Trigger } from "#/modules/mailbox/shapes.ts";
import { issueBranch, Repo } from "#/modules/repo/repo.ts";
import { NotRecorded, Session } from "#/modules/session/session.ts";
import * as q from "#db/issue.sql.ts";

import { issueBrief, splitBrief } from "./brief.ts";
import { issueRow } from "./creation.ts";
import { dependencyProblems } from "./dependencies.ts";
import { kept, openQuestions } from "./refinement.ts";
import { jsonOrNull, nullText } from "./rows.ts";
import { isClosed } from "./status.ts";
import { makeIssueStore } from "./store.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** Only while the issue is still open: a completion the user chose (kept, none) is written before its session leaves, and a child issue merges into its parent, so it does not merge into main here. */
const closingOf = (closed: T.SessionClose | undefined): { delivered: T.Landing } | { canceled: T.IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

export const issueLifecycle = Effect.gen(function* () {
  const core = yield* Core;
  const agents = yield* Agent;
  const repos = yield* Repo;
  const sessions = yield* Session;
  const mailbox = yield* Mailbox;
  const db = yield* Db;
  const store = yield* makeIssueStore;

  const loadKept = Effect.gen(function* () {
    const issues = yield* store.kept;
    yield* Effect.forEach(issues, (issue) => core.apply({ type: "issueChanged", issue }), { discard: true });
  });

  const everyIssue = store.all;

  const idOf = Effect.fn("Issue.idOf")(function* (ref: string): Effect.fn.Return<string, ApiError> {
    const r = ref.trim();
    const number = /^#?(\d+)$/u.exec(r)?.[1];
    if (number !== undefined) {
      const found = yield* store.byNumber(Number(number));
      if (!found) return yield* missing(t("server.issue.issueNumbered", { n: number }), [lookIn.issue]);
      return found;
    }
    const bySession = store.issueOfSession(r);
    if (bySession) return bySession;
    const hired = sessions.hired();
    const byName = hired.find((s) => s.name === r) ?? hired.find((s) => s.name !== "" && r.includes(s.name));
    return byName?.issue ?? r;
  });

  const get = Effect.fn("Issue.get")(function* (ref: string): Effect.fn.Return<T.Issue, ApiError> {
    const issue = yield* idOf(ref);
    const found = yield* store.byId(issue);
    if (!found) return yield* missing(t("server.issue.issueRef", { ref }), [lookIn.issue]);
    return found;
  });

  const ofCron = Effect.fn("Issue.ofCron")(function* (id: string) {
    return yield* store.latestOfCron(id);
  });

  const publish = (id: string) =>
    get(id).pipe(
      Effect.flatMap((issue) => core.apply({ type: "issueChanged", issue })),
      bestEffort(`vibevalley: issue ${id} changed but could not be read back for the board`),
    );

  /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
  const latest = (id: string) =>
    Effect.flatMap(get(id), (issue) => {
      const last = latestSessionIdOf(issue);
      return last === undefined ? Effect.fail(refused(t("server.issue.notStarted"))) : Effect.succeed(last);
    });

  const unsent = (id: string) =>
    Effect.filterOrFail(
      get(id),
      (issue) => executionsOf(issue).length === 0,
      () => refused(t("server.issue.started")),
    );

  const liveSession = (id: string) =>
    Effect.filterOrFail(
      latest(id),
      (session) => sessions.isReachable(session),
      (session) => missing(t("server.issue.helperRef", { id: session }), [lookIn.session]),
    );

  const issueWords = (req: Pick<T.IssueRequest, "title" | "description">) => {
    const [title, rest] = splitBrief(req.title);
    if (!title) return Effect.fail(refused(t("server.issue.noTitle")));
    let description = (req.description ?? "").trim();
    if (rest) description = (rest + "\n\n" + description).trim();
    return Effect.succeed([title, description] as const);
  };

  /** add, with the database refusing the row kept as a failure: hire tells it to the user. */
  const attemptAdd = Effect.fn("Issue.attemptAdd")(function* (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) {
    const [title, description] = yield* issueWords(req);
    if (req.constraints?.acceptance === true && !req.constraints.check?.trim()) return yield* refused(t("server.issue.verification.acceptanceNeedsCheck"));
    const id = newId();
    const parent = req.parent ? yield* get(req.parent) : undefined;
    if (parent && isClosed(parent.status)) return yield* refused(t("server.issue.dependencies.closedParent"));
    const repo = req.repo ?? parent?.repo;
    if (parent && repo !== parent.repo) return yield* refused(t("server.issue.dependencies.repo"));
    const blockedBy = [...new Set(req.blockedBy ?? [])];
    if (parent || blockedBy.length > 0) {
      const all = yield* everyIssue;
      if (dependencyProblems([...all, { id: issueId(id), blockedBy, ...(parent ? { parent: parent.id } : {}) }]).length > 0)
        return yield* refused(t("server.issue.dependencies.invalid"));
    }
    const at = yield* Clock.currentTimeMillis;
    yield* db.attemptTx(
      Effect.gen(function* () {
        yield* db.attempt(
          q.addIssue(
            issueRow(
              id,
              {
                ...req,
                title,
                description,
                blockedBy,
                ...(req.criteria ? { criteria: kept(req.criteria) } : {}),
                ...(repo ? { repo } : {}),
                ...(parent ? { parent: parent.id } : {}),
                deliver: req.deliver ?? (agents.isOrchestrator(req.agent ?? "") ? "answer" : "change"),
              },
              mandate,
              at,
              cron,
            ),
          ),
        );
        yield* store.assignInTx(id, req.agent ?? (parent ? assignedAgentOf(parent) : undefined), at, publish(id));
      }),
    );
    return yield* get(id);
  });

  const add = (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) =>
    attemptAdd(req, mandate, cron).pipe(Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }));

  const remove = Effect.fn("Issue.remove")(function* (id: string) {
    yield* store.remove(id);
    yield* core.apply({ type: "issueRemoved", id: issueId(id) });
  });

  const rankStep = 1024;
  const rankBound = 2_000_000_000;

  const place = Effect.fn("Issue.place")(function* (id: string, before: string) {
    const unsentIssues = (yield* everyIssue).filter((item) => executionsOf(item).length === 0);
    const from = unsentIssues.findIndex((item) => item.id === id);
    const moving = from >= 0 ? unsentIssues[from] : undefined;
    if (!moving) return;
    const rest = unsentIssues.filter((item) => item.id !== id);
    const rawAt = rest.findIndex((item) => item.id === before);
    const at = rawAt < 0 ? rest.length : rawAt;
    if (at === from) return;
    const prev = at > 0 ? rest[at - 1] : undefined;
    const next = at < rest.length ? rest[at] : undefined;
    const prevRank = prev === undefined ? undefined : (prev.rank ?? 0);
    const nextRank = next === undefined ? undefined : (next.rank ?? 0);
    let singleRank: number | undefined;
    if (prevRank === undefined && nextRank !== undefined) {
      const r = nextRank - rankStep;
      if (r >= -rankBound) singleRank = r;
    } else if (prevRank !== undefined && nextRank === undefined) {
      const r = prevRank + rankStep;
      if (r <= rankBound) singleRank = r;
    } else if (prevRank !== undefined && nextRank !== undefined && nextRank - prevRank >= 2) {
      singleRank = Math.trunc((prevRank + nextRank) / 2);
    }
    if (singleRank !== undefined) {
      yield* db.inTx(
        Effect.gen(function* () {
          yield* db.run(q.placeIssue({ rank: singleRank, id }));
          yield* db.afterCommit(publish(id));
        }),
      );
      return;
    }
    const ordered = [...rest];
    ordered.splice(at, 0, moving);
    const changed = ordered.flatMap((item, index) => {
      const target = (index + 1) * rankStep;
      return (item.rank ?? 0) === target ? [] : [{ id: item.id, rank: target }];
    });
    if (changed.length === 0) return;
    yield* db.inTx(
      Effect.gen(function* () {
        yield* Effect.forEach(changed, (each) => db.run(q.placeIssue(each)), { discard: true });
        yield* db.afterCommit(Effect.forEach(changed, (each) => publish(each.id), { discard: true }));
      }),
    );
  });

  const saveEdit = Effect.fn("Issue.saveEdit")(function* (
    id: string,
    fields: {
      readonly title: string;
      readonly description: string;
      readonly repo: string | undefined;
      readonly priority: T.Priority;
      readonly criteria: readonly string[];
      readonly deliver: T.Deliverable;
      readonly agent: string | undefined;
      readonly clearQuestions?: boolean;
      readonly before?: string;
    },
  ) {
    const at = yield* Clock.currentTimeMillis;
    yield* db.inTx(
      Effect.gen(function* () {
        yield* db.run(
          q.editIssue({
            title: fields.title,
            description: fields.description,
            repo: nullText(fields.repo),
            priority: fields.priority,
            criteria: jsonOrNull(fields.criteria, fields.criteria.length > 0),
            deliver: fields.deliver,
            id,
          }),
        );
        if (fields.clearQuestions === true) yield* db.run(q.setIssueQuestions({ id, questions: null }));
        yield* store.assignInTx(id, fields.agent, at, fields.before === undefined ? publish(id) : undefined);
      }),
    );
    if (fields.before !== undefined) yield* place(id, fields.before);
  });

  const saveRefinement = Effect.fn("Issue.saveRefinement")(function* (
    id: string,
    title: string,
    description: string,
    criteria: readonly string[],
    questions: readonly T.Question[] | undefined,
  ) {
    const open = openQuestions(questions);
    yield* db.run(
      q.refineIssue({
        id,
        title,
        description,
        criteria: jsonOrNull(criteria, criteria.length > 0),
        questions: jsonOrNull(open, open.length > 0),
      }),
    );
    yield* publish(id);
  });

  const complete = Effect.fn("Issue.complete")(function* (id: string, delivered: T.Landing) {
    const closed_at = yield* Clock.currentTimeMillis;
    yield* db.run(q.completeIssue({ closed_at, delivered, id }));
    yield* publish(id);
  });

  const cancelAs = Effect.fn("Issue.cancelAs")(function* (id: string, canceled: T.IssueCanceled) {
    const closed_at = yield* Clock.currentTimeMillis;
    yield* db.run(q.cancelIssue({ closed_at, canceled, id }));
    yield* publish(id);
  });

  const closeIfOpen = Effect.fn("Issue.closeIfOpen")(function* (sessionId: string, closed: T.SessionClose | undefined) {
    const issue = store.issueOfSession(sessionId);
    if (!issue) return;
    const current = yield* store.byId(issue);
    if (!current) return;
    const runs = store.sessionIdsOf(issue);
    // Closed already (completed by the user before its session went home): the verdict stands.
    if (runs.at(-1) !== sessionId || current.closedAt !== undefined) return;
    const closing = closingOf(closed);
    const closed_at = yield* Clock.currentTimeMillis;
    yield* db.run(
      "delivered" in closing
        ? q.completeOpenIssue({ closed_at, delivered: closing.delivered, id: issue })
        : q.cancelOpenIssue({ closed_at, canceled: closing.canceled, id: issue }),
    );
    yield* publish(issue);
  });

  const endRun = Effect.fn("Issue.endRun")(function* (id: string) {
    const item = yield* get(id);
    if (isClosed(item.status)) return;
    yield* publish(id);
  });

  const changesOf = Effect.fn("Issue.changesOf")(function* (item: T.Issue) {
    const session = latestSessionIdOf(item);
    if (session && sessions.isReachable(session))
      return yield* sessions.withWorkplace(session, (place) => repos.changes(place).pipe(Effect.mapError((error) => refused(error.message))));
    return item.repo ? yield* repos.branchChanges(item.repo, issueBranch(item.number)).pipe(Effect.mapError((error) => refused(error.message))) : undefined;
  });

  const setConflict = Effect.fn("Issue.setConflict")(function* (id: string, conflict: T.Conflict | undefined) {
    const current = yield* store.byId(id);
    if (!current) return;
    const stored = conflict ? jsonOrNull(conflict, true) : null;
    const prev = current.conflict ? jsonOrNull(current.conflict, true) : null;
    if (prev === stored) return;
    yield* db.run(q.setIssueConflict({ id, conflict: stored }));
    yield* publish(id);
  });

  const revive = (id: string) => Effect.andThen(db.run(q.reopenIssue({ id })), publish(id));

  const unqueue = (id: string) => Effect.andThen(db.run(q.unqueueIssue({ id })), publish(id));

  /** What the session waits on the user for, from its report; a report with none, or a comment, clears them. */
  const asked = (id: string, questions: readonly T.Question[] | undefined) =>
    Effect.andThen(db.run(q.setIssueQuestions({ id, questions: jsonOrNull(openQuestions(questions), openQuestions(questions).length > 0) })), publish(id));

  const recordReport = Effect.fn("Issue.recordReport")(function* (
    sessionId: string,
    outcome: T.Outcome,
    questions: readonly T.Question[] | undefined,
    checks: readonly T.CriterionCheck[],
    answer: T.IssueAnswer | undefined,
  ) {
    const issue = store.issueOfSession(sessionId);
    if (!issue) return undefined;
    const open = openQuestions(questions);
    const item = yield* get(issue);
    const isLatestAnswer = item.deliver === "answer" && latestSessionIdOf(item) === sessionId;
    yield* db.inTx(
      Effect.gen(function* () {
        yield* db.run(
          q.setIssueReport({
            id: issue,
            questions: jsonOrNull(open, open.length > 0),
            checks: jsonOrNull(checks, checks.length > 0),
          }),
        );
        if (isLatestAnswer && outcome === "completed") {
          yield* db.run(q.setIssueAnswer({ id: issue, answer: jsonOrNull(answer, answer !== undefined) }));
        }
        yield* db.afterCommit(publish(issue));
      }),
    );
    if (isLatestAnswer) yield* sessions.discardWork(sessionId);
    return issue;
  });

  /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
  const judged = (id: string, at: number, findings: readonly T.Finding[]) =>
    Effect.andThen(db.run(q.reviewIssue({ id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

  /** A new user reply invalidates the previous acceptance. */
  const userSaid = Effect.fn("Issue.userSaid")(function* (id: string) {
    const item = yield* get(id);
    yield* db.inTx(
      Effect.gen(function* () {
        yield* db.run(q.setIssueQuestions({ id, questions: null }));
        if (item.reviewedAt !== undefined) {
          yield* db.run(q.reviewIssue({ id, reviewed_at: null, findings: jsonOrNull(item.findings, item.findings.length > 0) }));
        }
        yield* db.afterCommit(publish(id));
      }),
    );
  });

  const withdrawDispatches = (id: string, at: number) => mailbox.withdraw({ _tag: "Issue", issue: id, at });

  /** The issue already owns its number and workplace before its session starts. */
  const recordHiredStart = Effect.fn("Issue.recordHiredStart")(function* (id: string, session: T.Session) {
    yield* db
      .attemptTx(
        Effect.gen(function* () {
          yield* db.attempt(q.reopenIssue({ id }));
          yield* store.executeInTx(id, session.agent, session.id, session.hiredAt, publish(id));
          yield* withdrawDispatches(id, session.hiredAt);
        }),
      )
      .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));
  });

  const recordOnDutyStart = Effect.fn("Issue.recordOnDutyStart")(function* (
    issue: T.Issue,
    agent: string,
    channel: string,
    input?: { readonly text: string; readonly by: T.RunTrigger },
  ) {
    const assignedAt = yield* Clock.currentTimeMillis;
    let dispatch: Trigger | undefined;
    yield* db.inTx(
      Effect.gen(function* () {
        if (isClosed(issue.status)) yield* db.run(q.reopenIssue({ id: issue.id }));
        yield* db.run(q.queueIssue({ id: issue.id, at: assignedAt }));
        yield* store.executeInTx(issue.id, agent, agent, assignedAt, publish(issue.id));
        if (input)
          dispatch = yield* mailbox.recordTrigger({
            source: "workbench",
            key: newId(),
            actor: { kind: "system", id: "system" },
            text: input.text,
            threads: [`issue:${issue.id}`],
            addressed: "thread_owner",
            replyChannel: channel,
            meta: { ingressRecipient: agent, issue: issue.id, trigger: input.by, dispatch: true },
            at: assignedAt,
          });
      }),
    );
    if (dispatch) yield* mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`));
  });

  const setQueued = Effect.fn("Issue.setQueued")(function* (id: string, queued: boolean, channel: string, by?: T.RunTrigger, source?: Trigger) {
    const item = yield* unsent(id);
    const at = yield* Clock.currentTimeMillis;
    let dispatch: Trigger | undefined;
    yield* db.inTx(
      Effect.gen(function* () {
        if (!queued) {
          yield* withdrawDispatches(id, at);
          yield* db.run(q.unqueueIssue({ id }));
          yield* db.afterCommit(publish(id));
          return;
        }
        const changed = yield* db.run(q.queueIssue({ at, id }));
        if (changed.length > 0 && !source)
          dispatch = yield* mailbox.recordTrigger({
            source: "workbench",
            key: newId(),
            actor: { kind: "system", id: "system" },
            text: issueBrief(item),
            threads: [`issue:${id}`],
            addressed: "thread_owner",
            replyChannel: channel,
            meta: { ingressRecipient: assignedAgentOf(item) ?? "", issue: id, trigger: by ?? { kind: "issue" }, dispatch: true },
            at,
          });
        yield* db.afterCommit(publish(id));
      }),
    );
    if (dispatch) yield* mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`));
    return yield* get(id);
  });

  const drop = Effect.fn("Issue.drop")(function* (id: string) {
    yield* unsent(id);
    const now = yield* Clock.currentTimeMillis;
    yield* db.inTx(
      Effect.gen(function* () {
        yield* Effect.all(
          [
            withdrawDispatches(id, now),
            db.run(q.unqueueIssue({ id })),
            db.run(q.cancelIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: "dismissed", id })),
          ],
          { discard: true },
        );
        yield* db.afterCommit(publish(id));
      }),
    );
  });

  const savePullRequest = Effect.fn("Issue.savePullRequest")(function* (id: string, pr: T.PullRequest) {
    yield* db.run(Effect.flatMap(jsonText(pr), (text) => q.setIssuePullRequest({ id, pull_request: text })));
    yield* publish(id);
  });

  const finishPullRequest = Effect.fn("Issue.finishPullRequest")(function* (issue: T.Issue, state: T.PullRequestState) {
    yield* db.inTx(
      Effect.gen(function* () {
        yield* db.run(
          state === "closed"
            ? q.cancelIssue({ id: issue.id, canceled: "dismissed", closed_at: yield* Clock.currentTimeMillis })
            : q.completeIssue({ id: issue.id, delivered: "pull_request", closed_at: yield* Clock.currentTimeMillis }),
        );
        yield* db.run(Effect.flatMap(jsonText({ ...issue.pullRequest, state }), (text) => q.setIssuePullRequest({ id: issue.id, pull_request: text })));
        yield* db.afterCommit(publish(issue.id));
      }),
    );
  });

  const saveSplit = Effect.fn("Issue.saveSplit")(function* (
    id: string,
    title: string,
    channel: string,
    parentMandate: T.IssueMandate,
    rows: readonly { readonly id: T.IssueId; readonly req: T.IssueRequest }[],
  ) {
    const at = yield* Clock.currentTimeMillis;
    const dispatches: Trigger[] = [];
    yield* db
      .attemptTx(
        Effect.gen(function* () {
          const current = yield* db.attempt(q.getIssue({ id }));
          const family = yield* db.attempt(q.family({ id }));
          if (current.closed_at !== null || family.some((item) => item.parent === id)) return yield* refused(t("server.issue.split.already"));
          if (title.trim())
            yield* db.attempt(
              q.editIssue({
                id,
                title: title.trim(),
                description: current.description,
                repo: current.repo,
                priority: current.priority,
                criteria: current.criteria,
                deliver: current.deliver,
              }),
            );
          yield* Effect.forEach(
            rows,
            (row) =>
              Effect.gen(function* () {
                yield* db.attempt(q.addIssue(issueRow(row.id, row.req, parentMandate, at)));
                const triggerRecorded = yield* mailbox.recordTrigger({
                  source: "workbench",
                  key: newId(),
                  actor: { kind: "system", id: "system" },
                  text: [row.req.title, row.req.description].filter(Boolean).join("\n\n"),
                  threads: [`issue:${row.id}`],
                  addressed: "thread_owner",
                  replyChannel: channel,
                  meta: { ingressRecipient: row.req.agent ?? "", issue: row.id, trigger: { kind: "issue" }, dispatch: true },
                  at,
                });
                dispatches.push(triggerRecorded);
                yield* db.attempt(q.queueIssue({ id: row.id, at }));
                yield* store.assignInTx(row.id, row.req.agent, at);
              }),
            { discard: true },
          );
          yield* db.afterCommit(publish(id));
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (error) => Effect.fail(error.pipe(causeMessage, refused)),
          SchemaError: Effect.die,
          NoSuchElementError: () => Effect.fail(missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue])),
        }),
      );
    yield* Effect.forEach(dispatches, (dispatch) => mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`)), {
      discard: true,
    });
    // Children reach the board only once their dispatches are held: the queue reacts to their issueChanged, and an
    // earlier one would find no queued input and, the issue then unchanged, never be told again.
    yield* Effect.forEach(rows, (row) => publish(row.id), { discard: true });
  });

  const completeChild = Effect.fn("Issue.completeChild")(function* (childId: string, constraints: T.IssueConstraints | undefined) {
    yield* db.inTx(
      Effect.gen(function* () {
        if (constraints) yield* db.run(Effect.flatMap(jsonText(constraints), (text) => q.setIssueConstraints({ id: childId, constraints: text })));
        yield* db.run(q.completeIssue({ closed_at: yield* Clock.currentTimeMillis, delivered: "merged_into_parent", id: childId }));
        yield* db.afterCommit(publish(childId));
      }),
    );
  });

  return {
    issueOfSession: store.issueOfSession,
    lastAssigneeIn: store.lastAssigneeIn,
    loadKept,
    everyIssue,
    idOf,
    get,
    ofCron,
    publish,
    unsent,
    liveSession,
    issueWords,
    attemptAdd,
    add,
    remove,
    saveEdit,
    saveRefinement,
    complete,
    cancelAs,
    closeIfOpen,
    endRun,
    changesOf,
    setConflict,
    revive,
    unqueue,
    asked,
    recordReport,
    judged,
    userSaid,
    recordHiredStart,
    recordOnDutyStart,
    setQueued,
    drop,
    savePullRequest,
    finishPullRequest,
    saveSplit,
    completeChild,
  };
});

export type IssueLifecycle = Effect.Success<typeof issueLifecycle>;
