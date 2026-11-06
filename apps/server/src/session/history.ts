import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOf, jsonOrNone } from "#/base/json.ts";
import { type Workplace } from "#/repo/workplace.ts";
import type * as qs from "#db/session.sql.ts";
import type * as qr from "#db/session_run.sql.ts";

const triggerOf = jsonOrNone(S.RunTrigger);
export const heardOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const spentOf = jsonOrNone(S.Spent);
const phaseOf = jsonOf(S.Phase);
const lastRunOf = jsonOf(S.LastRun);
const strictSpentOf = jsonOf(S.Spent);
export const placeOf = jsonOrNone(
  Schema.Struct({ repo: Schema.String, cwd: Schema.String, branch: Schema.optionalKey(Schema.String) }) satisfies Schema.Codec<Workplace>,
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
    role: r.role,
    name: r.name,
    agent: r.agent,
    runtime: r.runtime,
    brief: r.brief,
    hiredAt: r.hired_at,
    runs: runs.length,
    phase: { _tag: "closed", at: r.ended_at ?? 0, closed: r.closed ?? "dismissed" },
    refining: false,
    ...(r.repo !== null ? { repo: r.repo } : {}),
    ...(r.issue !== null ? { issue: issueId(r.issue) } : {}),
    ...(r.channel !== null ? { channel: r.channel } : {}),
  };
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

export function sessionState(s: T.Session): qs.KeepSessionStateParams {
  return {
    id: s.id,
    phase: JSON.stringify(s.phase),
    refining: s.refining,
    runs: s.runs,
    last_run: s.lastRun ? JSON.stringify(s.lastRun) : null,
    spent: s.spent ? JSON.stringify(s.spent) : null,
    channel: s.channel ?? null,
  };
}

export function restoredSession(row: qs.ActiveSessionsResult): T.Session {
  const phase = phaseOf(row.phase);
  const lastRun = row.last_run === null ? undefined : lastRunOf(row.last_run);
  const spent = row.spent === null ? undefined : strictSpentOf(row.spent);
  const place = row.place === null ? undefined : placeOf(row.place);
  return {
    id: sessionId(row.id),
    role: row.role,
    agent: row.agent,
    name: row.name,
    runtime: row.runtime,
    brief: row.brief,
    hiredAt: row.hired_at,
    refining: row.refining,
    runs: row.runs,
    phase: row.role === "orchestrator" ? { _tag: "resting" } : phase,
    ...(row.repo === null ? {} : { repo: row.repo }),
    ...(row.issue === null ? {} : { issue: issueId(row.issue) }),
    ...(row.channel === null ? {} : { channel: row.channel }),
    ...(place?.branch ? { branch: place.branch, worktree: place.cwd } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(spent ? { spent } : {}),
  };
}
