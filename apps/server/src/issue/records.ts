import { Clock, Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { type ApiError, Inconsistent, missing, lookIn, refused } from "#/errors.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { recordTrigger } from "#/mailbox/payload.ts";
import { issueBranch, Project } from "#/project/project.ts";
import { NotRecorded, Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";
import * as qs from "#db/issue_assignment.sql.ts";
import * as qe from "#db/issue_assignment_execution.sql.ts";

import { assignTo, Assignments } from "./assignment.ts";
import { issueBrief, splitBrief } from "./brief.ts";
import { issueRow } from "./creation.ts";
import { dependencyProblems } from "./dependencies.ts";
import { kept, openQuestions } from "./refinement.ts";
import { issueRows, jsonOrNull } from "./rows.ts";
import { isClosed, issueOrder } from "./status.ts";

export const issueRecords = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const core = yield* Core;
  const store = yield* Agent;
  const projects = yield* Project;
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
      (session) => sessions.present(session),
      (session) => missing(t("server.issue.helperRef", { id: session }), [lookIn.session]),
    );

  const issueWords = (req: Pick<T.IssueRequest, "title" | "description">) => {
    const [title, rest] = splitBrief(req.title);
    if (!title) return Effect.fail(refused(t("server.issue.noTitle")));
    let description = (req.description ?? "").trim();
    if (rest) description = (rest + "\n\n" + description).trim();
    return Effect.succeed([title, description] as const);
  };

  /** add, with the database refusing the row kept as a failure: hire tells it to the owner. */
  const attemptAdd = Effect.fn("Issue.attemptAdd")(function* (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) {
    const [title, description] = yield* issueWords(req);
    if (req.constraints?.acceptance === true && !req.constraints.check?.trim())
      return yield* Effect.fail(refused(t("server.issue.verification.acceptanceNeedsCheck")));
    const id = newId();
    const parent = req.parent ? yield* get(req.parent) : undefined;
    if (parent && isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
    const project = req.project ?? parent?.project;
    if (parent && project !== parent.project) return yield* Effect.fail(refused(t("server.issue.dependencies.project")));
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
              ...(project ? { project } : {}),
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

  const complete = (id: string, delivered: T.Delivery) =>
    Effect.andThen(db.run(q.completeIssue({ closed_at: clock.currentTimeMillisUnsafe(), delivered, id })), publish(id));
  const cancelAs = (id: string, canceled: T.IssueCanceled) =>
    Effect.andThen(db.run(q.cancelIssue({ closed_at: clock.currentTimeMillisUnsafe(), canceled, id })), publish(id));

  const endRun = Effect.fn("Issue.endRun")(function* (id: string) {
    const item = yield* get(id);
    if (isClosed(item.status)) return;
    yield* publish(id);
  });

  const changesOf = Effect.fn("Issue.changesOf")(function* (item: T.Issue) {
    const session = latestSessionIdOf(item);
    if (session && sessions.present(session))
      return yield* sessions.withWorkplace(session, (place) => projects.changes(place).pipe(Effect.mapError((error) => refused(error.message))));
    return item.project
      ? yield* projects.branchChanges(item.project, issueBranch(item.number)).pipe(Effect.mapError((error) => refused(error.message)))
      : undefined;
  });

  const setConflict = Effect.fn("Issue.setConflict")(function* (id: string, conflict: T.Conflict | undefined) {
    const row = yield* db.one(q.getIssue({ id }));
    if (!row) return;
    const stored = conflict ? JSON.stringify(conflict) : null;
    if (row.conflict === stored) return;
    yield* db.run(q.setIssueConflict({ id, conflict: stored }));
    yield* publish(id);
  });

  const reopenRow = (id: string) => Effect.andThen(db.run(q.reopenIssue({ id })), publish(id));

  /** What the session waits on the owner for, from its report; a report with none, or a comment, clears them. */
  const asked = (id: string, questions: readonly T.Question[] | undefined) =>
    Effect.andThen(db.run(q.setIssueQuestions({ id, questions: jsonOrNull(openQuestions(questions), openQuestions(questions).length > 0) })), publish(id));

  /** An answer issue's round: one that got through gives its conclusion (none readable leaves the issue stuck on it). */
  const answered = Effect.fn("Issue.answered")(function* (id: string, session: string, outcome: T.Outcome, answer: T.IssueAnswer | undefined) {
    const item = yield* get(id);
    if (item.deliver !== "answer" || latestSessionIdOf(item) !== session) return;
    if (outcome === "completed") yield* db.run(q.setIssueAnswer({ id, answer: jsonOrNull(answer, answer !== undefined) }));
    yield* sessions.discardWork(session);
    yield* publish(id);
  });

  /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
  const judged = (id: string, at: number, findings: readonly T.Finding[]) =>
    Effect.andThen(db.run(q.reviewIssue({ id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

  /** The owner's word answers what it asked, and starts a round that the last acceptance did not see. */
  const ownerSaid = Effect.fn("Issue.ownerSaid")(function* (id: string) {
    yield* asked(id, []);
    const item = yield* get(id);
    if (item.reviewedAt !== undefined) yield* judged(id, 0, item.findings);
  });

  const retireDispatches = (id: string, at: number) => mailbox.retireDispatches(id, at);

  /** The issue already owns its number and workplace before its session starts. */
  const ran = Effect.fn("Issue.ran")(function* (id: string, session: T.Session) {
    const linked = yield* db
      .attemptTx(
        Effect.gen(function* () {
          yield* q.reopenIssue({ id });
          const assignment = yield* assignTo(id, session.agent, session.hiredAt);
          if (!assignment.assigned) return yield* Effect.die(new Inconsistent({ message: "a session's profile must own its assignment" }));
          const execution = yield* qe.addExecution({
            assignment: assignment.assigned.id,
            executor: session.id,
            started_at: session.hiredAt,
          });
          yield* retireDispatches(id, session.hiredAt);
          return { assignment, execution };
        }),
      )
      .pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
    worked.changed(linked.assignment.changed);
    worked.executed(id, linked.execution);
    yield* publish(id);
  });

  const queueRow = Effect.fn("Issue.queueRow")(function* (id: string, queued: boolean, channel: string, by?: T.RunTrigger, source?: T.Trigger) {
    const item = yield* unsent(id);
    const at = yield* Clock.currentTimeMillis;
    let dispatch: T.Trigger | undefined;
    yield* db.inTx(
      Effect.gen(function* () {
        if (!queued) {
          yield* retireDispatches(id, at);
          yield* db.run(q.unqueueIssue({ id }));
          return;
        }
        const changed = yield* db.run(q.queueIssue({ at, id }));
        if (changed.length > 0 && !source)
          dispatch = yield* recordTrigger(db, {
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
    if (dispatch) yield* mailbox.receive(dispatch).pipe(bestEffort(`issue: route ${dispatch.id}`));
    yield* publish(id);
    return yield* get(id);
  });

  const drop = Effect.fn("Issue.drop")(function* (id: string) {
    yield* unsent(id);
    yield* db.inTx(
      Effect.all(
        [
          retireDispatches(id, yield* Clock.currentTimeMillis),
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

  /** On the board before another unsent issue, or last; only unsent issues have a place. */
  const place = Effect.fn("Issue.place")(function* (id: string, before: string) {
    const order: string[] = (yield* everyIssue).filter((item) => executionsOf(item).length === 0 && item.id !== id).map((item) => item.id);
    const at = order.indexOf(before);
    order.splice(at < 0 ? order.length : at, 0, id);
    yield* db.inTx(Effect.forEach(order, (each, rank) => db.run(q.placeIssue({ rank, id: each })), { discard: true }));
    yield* Effect.forEach(order, (each) => publish(each), { discard: true });
  });

  return {
    worked,
    reloadAssignments,
    issueOf,
    everyIssue,
    idOf,
    get,
    publish,
    latest,
    unsent,
    liveSession,
    issueWords,
    attemptAdd,
    add,
    complete,
    cancelAs,
    endRun,
    changesOf,
    setConflict,
    reopenRow,
    asked,
    answered,
    judged,
    ownerSaid,
    ran,
    queueRow,
    drop,
    place,
  };
});

export type IssueRecords = Effect.Success<typeof issueRecords>;
