import { Clock, Effect, Option } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { type ApiError, Inconsistent, missing, lookIn, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import { Core } from "#/core/core.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { issueBranch, Repo } from "#/repo/repo.ts";
import { NotRecorded, Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";
import * as qs from "#db/issue_assignment.sql.ts";
import * as qe from "#db/issue_assignment_execution.sql.ts";

import { assignTo, Assignments } from "./assignment.ts";
import { issueBrief, splitBrief } from "./brief.ts";
import { issueRow } from "./creation.ts";
import { dependencyProblems } from "./dependencies.ts";
import { kept, openQuestions } from "./refinement.ts";
import { issueRows, jsonOrNull, nullText } from "./rows.ts";
import { isClosed, issueOrder, keepClosedIssues } from "./status.ts";

/** Only while the issue is still open: a completion the user chose (kept, none) is written before its session leaves, and a child issue merges into its parent, so it does not merge into main here. */
const closingOf = (closed: T.SessionClose | undefined): { delivered: T.Delivery } | { canceled: T.IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

export const issueLifecycle = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const core = yield* Core;
  const store = yield* Agent;
  const repos = yield* Repo;
  const sessions = yield* Session;
  const mailbox = yield* Mailbox;
  const db = yield* Db;
  const worked = new Assignments();
  /** After an issue is removed: its sessions' rows went with it, and its children's. */
  const reloadAssignments = db.inTx(
    Effect.gen(function* () {
      const rows = yield* db.run(qs.allAssignments());
      const executions = yield* db.run(qe.allExecutions());
      worked.load(rows, executions);
    }),
  );
  yield* reloadAssignments;

  const issueOf = issueRows(core);

  const loadKept = Effect.gen(function* () {
    const rows = yield* db.run(q.keptIssues({ closed: keepClosedIssues }));
    yield* Effect.forEach(rows, (row) => core.apply({ type: "issueChanged", issue: issueOf(row, worked.of(row.id)) }), { discard: true });
  });

  const everyIssue = Effect.gen(function* () {
    const rows = yield* db.run(q.listIssues());
    return rows.map((r) => issueOf(r, worked.of(r.id))).toSorted(issueOrder);
  });

  const idOf = Effect.fn("Issue.idOf")(function* (ref: string): Effect.fn.Return<string, ApiError> {
    const r = ref.trim();
    const number = /^#?(\d+)$/u.exec(r)?.[1];
    if (number !== undefined) {
      const row = yield* db.one(q.issueByNumber({ number: Number(number) }));
      if (!row) return yield* Effect.fail(missing(t("server.issue.issueNumbered", { n: number }), [lookIn.issue]));
      return row.id;
    }
    return worked.issueOf(r) ?? r;
  });

  const get = Effect.fn("Issue.get")(function* (ref: string): Effect.fn.Return<T.Issue, ApiError> {
    const issue = yield* idOf(ref);
    const row = yield* db.one(q.getIssue({ id: issue }));
    if (!row) return yield* Effect.fail(missing(t("server.issue.issueRef", { ref }), [lookIn.issue]));
    return issueOf(row, worked.of(issue));
  });

  const ofCron = Effect.fn("Issue.ofCron")(function* (id: string) {
    const row = yield* db.one(q.latestOfCron({ cron: id }));
    if (!row) return undefined;
    const found = yield* Effect.option(get(row.id));
    return Option.getOrUndefined(found);
  });

  const lastAssigneeIn = (repo: string) => Effect.map(db.one(qs.lastAssigneeIn({ repo })), (row) => row?.agent);

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
    if (req.constraints?.acceptance === true && !req.constraints.check?.trim())
      return yield* Effect.fail(refused(t("server.issue.verification.acceptanceNeedsCheck")));
    const id = newId();
    const parent = req.parent ? yield* get(req.parent) : undefined;
    if (parent && isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
    const repo = req.repo ?? parent?.repo;
    if (parent && repo !== parent.repo) return yield* Effect.fail(refused(t("server.issue.dependencies.repo")));
    const blockedBy = [...new Set(req.blockedBy ?? [])];
    if (parent || blockedBy.length > 0) {
      const all = yield* everyIssue;
      if (dependencyProblems([...all, { id: issueId(id), blockedBy, ...(parent ? { parent: parent.id } : {}) }]).length > 0)
        return yield* Effect.fail(refused(t("server.issue.dependencies.invalid")));
    }
    const at = yield* Clock.currentTimeMillis;
    const assignment = yield* db.attemptTx(
      Effect.gen(function* () {
        yield* q.addIssue(
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
              deliver: req.deliver ?? (store.isOrchestrator(req.agent ?? "") ? "answer" : "change"),
            },
            mandate,
            at,
            cron,
          ),
        );
        return yield* assignTo(id, req.agent ?? (parent ? assignedAgentOf(parent) : undefined), at);
      }),
    );
    worked.changed(assignment.changed);
    yield* publish(id);
    return yield* get(id);
  });

  const add = (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) =>
    attemptAdd(req, mandate, cron).pipe(Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }));

  const remove = Effect.fn("Issue.remove")(function* (id: string) {
    yield* db.run(q.removeIssue({ id }));
    yield* reloadAssignments;
    yield* core.apply({ type: "issueRemoved", id: issueId(id) });
  });

  const place = Effect.fn("Issue.place")(function* (id: string, before: string) {
    const order: string[] = (yield* everyIssue).filter((item) => executionsOf(item).length === 0 && item.id !== id).map((item) => item.id);
    const at = order.indexOf(before);
    order.splice(at < 0 ? order.length : at, 0, id);
    yield* db.inTx(Effect.forEach(order, (each, rank) => db.run(q.placeIssue({ rank, id: each })), { discard: true }));
    yield* Effect.forEach(order, (each) => publish(each), { discard: true });
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
    const assignment = yield* db.run(
      db.attemptTx(
        Effect.gen(function* () {
          yield* q.editIssue({
            title: fields.title,
            description: fields.description,
            repo: nullText(fields.repo),
            priority: fields.priority,
            criteria: jsonOrNull(fields.criteria, fields.criteria.length > 0),
            deliver: fields.deliver,
            id,
          });
          if (fields.clearQuestions === true) yield* q.setIssueQuestions({ id, questions: null });
          return yield* assignTo(id, fields.agent, at);
        }),
      ),
    );
    worked.changed(assignment.changed);
    if (fields.before !== undefined) yield* place(id, fields.before);
    else yield* publish(id);
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

  const complete = (id: string, delivered: T.Delivery) =>
    Effect.andThen(db.run(q.completeIssue({ closed_at: clock.currentTimeMillisUnsafe(), delivered, id })), publish(id));
  const cancelAs = (id: string, canceled: T.IssueCanceled) =>
    Effect.andThen(db.run(q.cancelIssue({ closed_at: clock.currentTimeMillisUnsafe(), canceled, id })), publish(id));

  const closeIfOpen = Effect.fn("Issue.closeIfOpen")(function* (sessionId: string, closed: T.SessionClose | undefined) {
    const issue = worked.issueOf(sessionId);
    if (!issue) return;
    const row = yield* db.one(q.getIssue({ id: issue }));
    if (!row) return;
    const runs = worked.sessionIds(issue);
    // Closed already (completed by the user before its session went home): the verdict stands.
    if (runs.at(-1) !== sessionId || row.closed_at !== null) return;
    const closing = closingOf(closed);
    yield* db.run(
      "delivered" in closing
        ? q.completeOpenIssue({ closed_at: yield* Clock.currentTimeMillis, delivered: closing.delivered, id: issue })
        : q.cancelOpenIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: closing.canceled, id: issue }),
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
    const row = yield* db.one(q.getIssue({ id }));
    if (!row) return;
    const stored = conflict ? jsonOrNull(conflict, true) : null;
    if (row.conflict === stored) return;
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
    const issue = worked.issueOf(sessionId);
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
      }),
    );
    if (isLatestAnswer) yield* sessions.discardWork(sessionId);
    yield* publish(issue);
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
      }),
    );
    yield* publish(id);
  });

  const withdrawDispatches = (id: string, at: number) => mailbox.withdraw({ _tag: "Issue", issue: id, at });

  /** The issue already owns its number and workplace before its session starts. */
  const recordHiredStart = Effect.fn("Issue.recordHiredStart")(function* (id: string, session: T.Session) {
    const linked = yield* db
      .attemptTx(
        Effect.gen(function* () {
          yield* q.reopenIssue({ id });
          const assignment = yield* assignTo(id, session.agent, session.hiredAt);
          if (!assignment.assigned) return yield* Effect.die(Inconsistent.make({ message: "a session's profile must own its assignment" }));
          const execution = yield* qe.addExecution({
            assignment: assignment.assigned.id,
            executor: session.id,
            started_at: session.hiredAt,
          });
          yield* withdrawDispatches(id, session.hiredAt);
          return { assignment, execution };
        }),
      )
      .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));
    worked.changed(linked.assignment.changed);
    worked.executed(id, linked.execution);
    yield* publish(id);
  });

  const recordOnDutyStart = Effect.fn("Issue.recordOnDutyStart")(function* (
    issue: T.Issue,
    agent: string,
    channel: string,
    input?: { readonly text: string; readonly by: T.RunTrigger },
  ) {
    const assignedAt = yield* Clock.currentTimeMillis;
    let dispatch: T.Trigger | undefined;
    const linked = yield* db.run(
      db.attemptTx(
        Effect.gen(function* () {
          if (isClosed(issue.status)) yield* q.reopenIssue({ id: issue.id });
          yield* q.queueIssue({ id: issue.id, at: assignedAt });
          const assignment = yield* assignTo(issue.id, agent, assignedAt);
          if (!assignment.assigned) return yield* Effect.die(Inconsistent.make({ message: "an orchestrator's profile must own its assignment" }));
          const execution = yield* qe.addExecution({
            assignment: assignment.assigned.id,
            executor: agent,
            started_at: assignedAt,
          });
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
          return { assignment, execution };
        }),
      ),
    );
    if (dispatch) yield* mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`));
    worked.changed(linked.assignment.changed);
    worked.executed(issue.id, linked.execution);
    yield* publish(issue.id);
  });

  const setQueued = Effect.fn("Issue.setQueued")(function* (id: string, queued: boolean, channel: string, by?: T.RunTrigger, source?: T.Trigger) {
    const item = yield* unsent(id);
    const at = yield* Clock.currentTimeMillis;
    let dispatch: T.Trigger | undefined;
    yield* db.inTx(
      Effect.gen(function* () {
        if (!queued) {
          yield* withdrawDispatches(id, at);
          yield* db.run(q.unqueueIssue({ id }));
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
      }),
    );
    if (dispatch) yield* mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`));
    yield* publish(id);
    return yield* get(id);
  });

  const drop = Effect.fn("Issue.drop")(function* (id: string) {
    yield* unsent(id);
    const now = yield* Clock.currentTimeMillis;
    yield* db.inTx(
      Effect.all(
        [
          withdrawDispatches(id, now),
          db.run(q.unqueueIssue({ id })),
          db.run(q.cancelIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: "dismissed", id })),
        ],
        {
          discard: true,
        },
      ),
    );
    yield* publish(id);
  });

  const savePullRequest = Effect.fn("Issue.savePullRequest")(function* (id: string, pr: T.PullRequest) {
    yield* db.run(Effect.flatMap(jsonText(pr), (text) => q.setIssuePullRequest({ id, pull_request: text })));
    yield* publish(id);
  });

  const finishPullRequest = Effect.fn("Issue.finishPullRequest")(function* (issue: T.Issue, state: T.PullRequestState) {
    yield* db.inTx(
      Effect.andThen(
        db.run(
          state === "closed"
            ? q.cancelIssue({ id: issue.id, canceled: "dismissed", closed_at: yield* Clock.currentTimeMillis })
            : q.completeIssue({ id: issue.id, delivered: "pull_request", closed_at: yield* Clock.currentTimeMillis }),
        ),
        db.run(Effect.flatMap(jsonText({ ...issue.pullRequest, state }), (text) => q.setIssuePullRequest({ id: issue.id, pull_request: text }))),
      ),
    );
    yield* publish(issue.id);
  });

  const saveSplit = Effect.fn("Issue.saveSplit")(function* (
    id: string,
    title: string,
    channel: string,
    parentMandate: T.IssueMandate,
    rows: readonly { readonly id: T.IssueId; readonly req: T.IssueRequest }[],
  ) {
    const at = yield* Clock.currentTimeMillis;
    const dispatches: T.Trigger[] = [];
    const assignments = yield* db
      .attemptTx(
        Effect.gen(function* () {
          const current = yield* q.getIssue({ id });
          const family = yield* q.family({ id });
          if (current.closed_at !== null || family.some((item) => item.parent === id)) return yield* Effect.fail(refused(t("server.issue.split.already")));
          if (title.trim())
            yield* q.editIssue({
              id,
              title: title.trim(),
              description: current.description,
              repo: current.repo,
              priority: current.priority,
              criteria: current.criteria,
              deliver: current.deliver,
            });
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              yield* q.addIssue(issueRow(row.id, row.req, parentMandate, at));
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
              yield* q.queueIssue({ id: row.id, at });
              return yield* assignTo(row.id, row.req.agent, at);
            }),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (error) => Effect.fail(error.pipe(causeMessage, refused)),
          SchemaError: Effect.die,
          NoSuchElementError: () => Effect.fail(missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue])),
        }),
      );
    for (const assignment of assignments) worked.changed(assignment.changed);
    yield* Effect.forEach(dispatches, (dispatch) => mailbox.receive({ _tag: "Trigger", trigger: dispatch }).pipe(bestEffort(`issue: route ${dispatch.id}`)), {
      discard: true,
    });
    yield* Effect.forEach(rows, (row) => publish(row.id), { discard: true });
    yield* publish(id);
  });

  const completeChild = Effect.fn("Issue.completeChild")(function* (childId: string, constraints: T.IssueConstraints | undefined) {
    yield* db.inTx(
      Effect.gen(function* () {
        if (constraints) yield* db.run(Effect.flatMap(jsonText(constraints), (text) => q.setIssueConstraints({ id: childId, constraints: text })));
        yield* db.run(q.completeIssue({ closed_at: yield* Clock.currentTimeMillis, delivered: "merged_into_parent", id: childId }));
      }),
    );
    yield* publish(childId);
  });

  return {
    worked,
    reloadAssignments,
    issueOf,
    loadKept,
    everyIssue,
    idOf,
    get,
    ofCron,
    lastAssigneeIn,
    publish,
    latest,
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
    place,
    savePullRequest,
    finishPullRequest,
    saveSplit,
    completeChild,
  };
});

export type IssueLifecycle = Effect.Success<typeof issueLifecycle>;
