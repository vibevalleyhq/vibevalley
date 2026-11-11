import { Array as Arr, Effect } from "effect";

import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import * as q from "#db/issue.sql.ts";
import * as qs from "#db/issue_assignment.sql.ts";
import * as qe from "#db/issue_assignment_execution.sql.ts";

import { assignTo, Assignments } from "./assignment.ts";
import { issueRows } from "./rows.ts";
import { issueOrder, keepClosedIssues } from "./status.ts";

/** Owns the in-memory `Assignments` index alongside SQLite writes so callers never touch uncommitted responsibility state. */
export const makeIssueStore = Effect.gen(function* () {
  const core = yield* Core;
  const db = yield* Db;
  const worked = new Assignments();
  const hydrate = issueRows(core);

  yield* db.inTx(
    Effect.gen(function* () {
      const rows = yield* db.run(qs.allAssignments());
      const executions = yield* db.run(qe.allExecutions());
      worked.load(rows, executions);
    }),
  );

  const issueOfRow = (row: q.GetIssueResult): T.Issue => hydrate(row, worked.of(row.id));

  return {
    issueOfSession: (session: string): string | undefined => worked.issueOf(session),
    sessionIdsOf: (issue: string): readonly T.SessionId[] => worked.sessionIds(issue),
    kept: Effect.map(db.run(q.keptIssues({ closed: keepClosedIssues })), Arr.map(issueOfRow)),
    all: Effect.map(db.run(q.listIssues()), (rows) => Arr.map(rows, issueOfRow).toSorted(issueOrder)),
    byId: (id: string) => Effect.map(db.one(q.getIssue({ id })), (row) => (row === undefined ? undefined : issueOfRow(row))),
    byNumber: (number: number) => Effect.map(db.one(q.issueByNumber({ number })), (row) => row?.id),
    latestOfCron: (cron: string) => Effect.map(db.one(q.latestOfCron({ cron })), (row) => (row === undefined ? undefined : issueOfRow(row))),
    lastAssigneeIn: (repo: string) => Effect.map(db.one(qs.lastAssigneeIn({ repo })), (row) => row?.agent),
    /** Assigns `agent` inside the current transaction and applies the index delta only after commit. */
    assignInTx: Effect.fnUntraced(function* (issue: string, agent: string | undefined, at: number, after?: Effect.Effect<void>) {
      const assignment = yield* assignTo(db, issue, agent, at);
      yield* db.afterCommit(
        Effect.gen(function* () {
          worked.changed(assignment.changed);
          if (after !== undefined) yield* after;
        }),
      );
      return assignment.assigned;
    }),
    /** Records an execution on `agent`'s active assignment inside the current transaction and applies both index deltas after commit. */
    executeInTx: Effect.fnUntraced(function* (issue: string, agent: string, executor: string, startedAt: number, after?: Effect.Effect<void>) {
      const assignment = yield* assignTo(db, issue, agent, startedAt);
      if (!assignment.assigned) return yield* Effect.die(Inconsistent.make({ message: "an executor's profile must own its assignment" }));
      const execution = yield* db
        .attempt(
          qe.addExecution({
            assignment: assignment.assigned.id,
            executor,
            started_at: startedAt,
          }),
        )
        .pipe(Effect.catchTags({ NoSuchElementError: Effect.die, SchemaError: Effect.die }));
      yield* db.afterCommit(
        Effect.gen(function* () {
          worked.changed(assignment.changed);
          worked.executed(issue, execution);
          if (after !== undefined) yield* after;
        }),
      );
    }),
    /** Deletes `id` (and any cascaded child issues) in one transaction, pruning the in-memory index on commit without full-table reloads. */
    remove: Effect.fnUntraced(function* (id: string) {
      yield* db.inTx(
        Effect.gen(function* () {
          const family = yield* db.run(q.family({ id }));
          yield* db.run(q.removeIssue({ id }));
          const gone = family.length > 0 ? Arr.map(family, (row) => row.id) : [id];
          yield* db.afterCommit(Effect.sync(() => worked.removed(gone)));
        }),
      );
    }),
  };
});

export type IssueStore = Effect.Success<typeof makeIssueStore>;
