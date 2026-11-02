import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import type * as T from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { causeMessage, Db } from "@/infra/db.ts";

import * as qr from "../../db/generated/session_run.sql.ts";
import * as qi from "../../db/generated/session_run_issue.sql.ts";

export class NotRecorded extends Schema.TaggedError<NotRecorded, { readonly brand: unique symbol }>()("NotRecorded", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const recording = Effect.gen(function* () {
  const db = yield* Db;
  const clock = yield* Clock.Clock;
  const tried = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    db.attempt(effect).pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
  return {
    start: (id: string, session: string, issue: string, trigger: T.RunTrigger) =>
      tried(qr.startRun({ id, session, issue: issue || null, triggered_by: JSON.stringify(trigger), started_at: clock.currentTimeMillisUnsafe() })),
    link: (run: string, issue: string) => tried(qi.linkRunIssue({ run, issue })),
    heard: (id: string, heard: readonly string[]) => tried(qr.heardInRun({ heard: JSON.stringify(heard), id })),
    issues: (run: string) => Effect.map(tried(qi.runIssues({ run })), (rows) => rows.map((row) => issueId(row.issue))),
    finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) =>
      tried(qr.endRun({ ended_at: clock.currentTimeMillisUnsafe(), outcome, summary: summary || null, spent: spent ? JSON.stringify(spent) : null, id })),
  };
});
