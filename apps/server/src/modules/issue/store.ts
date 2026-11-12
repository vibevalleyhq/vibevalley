import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { type Db, SqlError } from "#/infra/db.ts";
import * as q from "#db/issue.sql.ts";
import * as qs from "#db/issue_assignment.sql.ts";
import * as qe from "#db/issue_assignment_execution.sql.ts";

import { assignTo, Assignments } from "./assignment.ts";
import { issueRows } from "./rows.ts";
import { issueOrder, keepClosedIssues } from "./status.ts";

export type IssueStore = Awaited<ReturnType<typeof makeIssueStore>>;

/** Owns the in-memory `Assignments` index alongside the database's writes so callers never touch uncommitted responsibility state. */
export async function makeIssueStore(deps: { readonly core: Core; readonly db: Db }) {
  const { core, db } = deps;
  const worked = new Assignments();
  const hydrate = issueRows(core);

  await db.tx(async () => {
    const rows = await qs.allAssignments(db.sql);
    const executions = await qe.allExecutions(db.sql);
    worked.load(rows, executions);
  });

  const issueOfRow = (row: q.GetIssueResult): T.Issue => hydrate(row, worked.of(row.id));

  return {
    issueOfSession: (session: string): string | undefined => worked.issueOf(session),
    sessionIdsOf: (issue: string): readonly T.SessionId[] => worked.sessionIds(issue),
    kept: async () => (await q.keptIssues(db.sql, { closed: keepClosedIssues })).map(issueOfRow),
    all: async () => (await q.listIssues(db.sql)).map(issueOfRow).toSorted(issueOrder),
    byId: async (id: string) => {
      const row = await q.getIssue(db.sql, { id });
      return row === undefined ? undefined : issueOfRow(row);
    },
    byNumber: async (number: number) => (await q.issueByNumber(db.sql, { number }))?.id,
    latestOfCron: async (cron: string) => {
      const row = await q.latestOfCron(db.sql, { cron });
      return row === undefined ? undefined : issueOfRow(row);
    },
    lastAssigneeIn: async (repo: string) => (await qs.lastAssigneeIn(db.sql, { repo }))?.agent,
    /** Assigns `agent` inside the current transaction and applies the index delta only after commit. */
    assignInTx: async (issue: string, agent: string | undefined, at: number, after?: () => Promise<void>) => {
      const assignment = await assignTo(db, issue, agent, at);
      await db.afterCommit(async () => {
        worked.changed(assignment.changed);
        if (after !== undefined) await after();
      });
      return assignment.assigned;
    },
    /** Records an execution on `agent`'s active assignment inside the current transaction and applies both index deltas after commit. */
    executeInTx: async (issue: string, agent: string, executor: string, startedAt: number, after?: () => Promise<void>) => {
      const assignment = await assignTo(db, issue, agent, startedAt);
      if (!assignment.assigned) throw new Inconsistent("an executor's profile must own its assignment");
      let execution: qe.AddExecutionResult | undefined;
      try {
        execution = await qe.addExecution(db.sql, { assignment: assignment.assigned.id, executor, started_at: startedAt });
      } catch (e) {
        // The database's own failure goes up as itself, for the caller's refusal; a row that does not read is a bug.
        if (e instanceof SqlError) throw e;
        throw new Inconsistent(`issue ${issue}: an execution row did not read`, { cause: e });
      }
      if (execution === undefined) throw new Inconsistent(`issue ${issue}: an execution insert returned no row`);
      const added = execution;
      await db.afterCommit(async () => {
        worked.changed(assignment.changed);
        worked.executed(issue, added);
        if (after !== undefined) await after();
      });
    },
    /** Deletes `id` (and any cascaded child issues) in one transaction, pruning the in-memory index on commit without full-table reloads. */
    remove: async (id: string) => {
      await db.tx(async () => {
        const family = await q.family(db.sql, { id });
        await q.removeIssue(db.sql, { id });
        const gone = family.length > 0 ? family.map((row) => row.id) : [id];
        await db.afterCommit(() => worked.removed(gone));
      });
    },
  };
}
