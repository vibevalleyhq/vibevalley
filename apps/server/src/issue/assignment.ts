import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { newId } from "@/base/ids.ts";
import { compare, compareText, or } from "@/base/order.ts";

import * as q from "../../db/generated/issue_assignment.sql.ts";
import type * as qe from "../../db/generated/issue_assignment_execution.sql.ts";
import { nullText } from "./stored.ts";

/** Called in the transaction that changes responsibility. */
export const assignTo = Effect.fnUntraced(function* (issue: string, agent: string | undefined, at: number) {
  const assignedAgent = nullText(agent);
  const ended = yield* q.endAssignments({ issue, agent: assignedAgent, ended_at: at });
  const assigned = assignedAgent
    ? yield* q.addAssignment({ id: newId(), issue, agent: assignedAgent, assigned_at: at }).pipe(Effect.catchTag("NoSuchElementError", Effect.die))
    : undefined;
  return { changed: assigned ? [...ended, assigned] : ended, assigned };
});

const executionOf = (row: qe.AddExecutionResult): T.Assignment["executions"][number] =>
  row.role === "worker"
    ? { kind: "session", session: sessionId(row.executor), startedAt: row.started_at }
    : { kind: "orchestrator", session: row.executor, startedAt: row.started_at };

/** Only committed relations enter the index; deleting an issue reloads it after the cascade. */
export class Assignments {
  private byIssue = new Map<string, q.AddAssignmentResult[]>();
  private executions = new Map<string, T.Assignment["executions"]>();
  private issueOfSession = new Map<string, string>();

  load(rows: readonly q.AllAssignmentsResult[], executions: readonly qe.AllExecutionsResult[]) {
    this.byIssue.clear();
    this.executions.clear();
    this.issueOfSession.clear();
    this.changed(rows);
    for (const row of executions) this.executed(row.issue, row);
  }

  changed(rows: readonly q.AddAssignmentResult[]) {
    for (const row of rows) {
      const existing = this.byIssue.get(row.issue) ?? [];
      const ended = existing.find((a) => a.id === row.id)?.ended_at;
      const kept = ended === undefined || ended === null ? row : { ...row, ended_at: ended };
      this.byIssue.set(
        row.issue,
        [...existing.filter((a) => a.id !== row.id), kept].toSorted((a, b) => or(compare(a.assigned_at, b.assigned_at), compareText(a.id, b.id))),
      );
    }
  }

  executed(issue: string, row: qe.AddExecutionResult) {
    const existing = this.executions.get(row.assignment) ?? [];
    if (!existing.some((e) => e.session === row.executor))
      this.executions.set(
        row.assignment,
        [...existing, executionOf(row)].toSorted((a, b) => a.startedAt - b.startedAt),
      );
    if (row.role === "worker") this.issueOfSession.set(row.executor, issue);
  }

  issueOf(session: string): string | undefined {
    return this.issueOfSession.get(session);
  }

  of(issue: string): T.Assignment[] {
    return (this.byIssue.get(issue) ?? []).map((row) => ({
      id: row.id,
      issue: issueId(row.issue),
      agent: row.agent,
      assignedAt: row.assigned_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      executions: [...(this.executions.get(row.id) ?? [])],
    }));
  }

  sessionIds(issue: string): T.SessionId[] {
    return this.of(issue)
      .flatMap((a) => a.executions)
      .toSorted((a, b) => or(compare(a.startedAt, b.startedAt), compareText(a.session, b.session)))
      .flatMap((e) => (e.kind === "session" ? [e.session] : []));
  }
}
