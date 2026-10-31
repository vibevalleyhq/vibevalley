import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "@/base/json.ts";
import { type Workplace } from "@/project/shapes.ts";

import type * as qs from "../../db/generated/session.sql.ts";
import type * as qr from "../../db/generated/session_run.sql.ts";

const triggerOf = jsonOrNone(S.RunTrigger);
export const heardOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const spentOf = jsonOrNone(S.Spent);
const graphOf = jsonOrNone(S.SessionGraph);
export const placeOf = jsonOrNone(
  Schema.Struct({ project: Schema.String, cwd: Schema.String, branch: Schema.optionalKey(Schema.String) }) satisfies Schema.Codec<Workplace>,
);

export function runOf(r: qr.RunsOfSessionResult): T.Run {
  const run: T.Run = {
    id: r.id,
    session: sessionId(r.session),
    triggeredBy: triggerOf(r.triggered_by) ?? { kind: "runtime" },
    heard: heardOf(r.heard) ?? [],
    startedAt: r.started_at,
    summary: r.summary ?? "",
  };
  if (r.issue !== null) run.issue = issueId(r.issue);
  if (r.ended_at !== null) run.endedAt = r.ended_at;
  if (r.outcome !== null) run.outcome = r.outcome;
  const spent = spentOf(r.spent);
  if (spent) run.spent = spent;
  return run;
}

/** An ended session as the core state would have had it: its runs counted, its last one's word, what it spent in all. */

export function endedSession(r: qs.SessionByIDResult, runs: readonly qr.RunsOfSessionResult[]): T.Session {
  const s: T.Session = {
    id: sessionId(r.id),
    name: r.name,
    agent: r.agent,
    runtime: r.runtime,
    brief: r.brief,
    hiredAt: r.hired_at,
    runs: runs.length,
    phase: { _tag: "closed", at: r.ended_at ?? 0, closed: r.closed ?? "dismissed" },
    refining: false,
    ...(r.project !== null ? { project: r.project } : {}),
    ...(r.issue !== null ? { issue: issueId(r.issue) } : {}),
  };
  const graph = graphOf(r.graph);
  if (graph) s.graph = graph;
  let tokens = 0;
  let cny = 0;
  let priced = false;
  for (const run of runs) {
    const one = spentOf(run.spent);
    if (!one) continue;
    tokens += one.tokens;
    if (one.cny !== undefined) {
      cny += one.cny;
      priced = true;
    }
  }
  if (tokens > 0 || priced) s.spent = { tokens, ...(priced ? { cny } : {}) };
  const last = runs.at(-1);
  if (last?.outcome) s.lastRun = { outcome: last.outcome, summary: last.summary ?? "", at: last.ended_at ?? 0 };
  return s;
}
