import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { sessionIdsOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "#/base/json.ts";
import { type Core } from "#/core/core.ts";
import type * as q from "#db/issue.sql.ts";

import { statusMoves } from "./moves.ts";
import { issueRefiningOf, issueStageIn, issueStatusOf } from "./status.ts";

export const nullText = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

export const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);

type Row = q.GetIssueResult;
const strings = Schema.mutable(Schema.Array(Schema.String));
const column = {
  constraints: jsonOrNone(S.IssueConstraints),
  conflict: jsonOrNone(S.Conflict),
  strings: jsonOrNone(strings),
  checks: jsonOrNone(Schema.mutable(Schema.Array(S.CriterionCheck))),
  pullRequest: jsonOrNone(S.PullRequest),
  answer: jsonOrNone(S.IssueAnswer),
  findings: jsonOrNone(Schema.mutable(Schema.Array(S.Finding))),
  questions: jsonOrNone(Schema.mutable(Schema.Array(S.Question))),
};

export function issueRows(core: Core["Service"]) {
  return function issueOf(row: Row, assignments: readonly T.Assignment[]): T.Issue {
    const state = core.state();
    const blockedBy = column.strings(row.blocked_by);
    const criteria = column.strings(row.criteria);
    const checks = column.checks(row.checks);
    const pullRequest = column.pullRequest(row.pull_request);
    const lastRun =
      row.run_started_at === null
        ? undefined
        : {
            startedAt: row.run_started_at,
            ...(row.run_ended_at === null ? {} : { endedAt: row.run_ended_at }),
            ...(row.run_outcome === null ? {} : { outcome: row.run_outcome }),
          };
    const answer = column.answer(row.answer);
    const constraints = column.constraints(row.constraints);
    const conflict = column.conflict(row.conflict);
    const out: T.Issue = {
      id: issueId(row.id),
      number: row.number,
      title: row.title,
      ...(constraints ? { constraints } : {}),
      ...(conflict ? { conflict } : {}),
      description: row.description,
      mandate: {
        ...(row.origin_trigger_id === null ? {} : { originTriggerId: row.origin_trigger_id }),
        strength: row.mandate_strength,
        maxBotReviewRounds: row.max_bot_review_rounds,
        autoSubmitPr: row.auto_submit_pr,
      },
      ...(row.repo !== null ? { repo: row.repo } : {}),
      assignments: [...assignments],
      priority: row.priority,
      createdAt: row.created_at,
      ...(row.queued_at !== null ? { queuedAt: row.queued_at } : {}),
      ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
      ...(row.delivered !== null ? { delivered: row.delivered } : {}),
      ...(row.canceled !== null ? { canceled: row.canceled } : {}),
      ...(row.parent !== null ? { parent: issueId(row.parent) } : {}),
      blockedBy: blockedBy ?? [],
      ...(row.cron !== null ? { cron: row.cron } : {}),
      status: "backlog",
      moves: [],
      ...(pullRequest ? { pullRequest } : {}),
      deliver: row.deliver,
      ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
      findings: column.findings(row.findings) ?? [],
      questions: column.questions(row.questions) ?? [],
      criteria: criteria ?? [],
      checks: checks ?? [],
      ...(lastRun ? { lastRun } : {}),
      ...(answer ? { answer } : {}),
      stage: { state: "draft", acts: [] },
    };
    if (sessionIdsOf(out).length === 0 && row.rank !== 0) out.rank = row.rank;
    out.status = issueStatusOf(out, state);
    const refiner = issueRefiningOf(out, state);
    if (refiner) out.refining = refiner;
    // The moves read the stage: a round that failed is not completed.
    out.stage = issueStageIn(out, state);
    out.moves = statusMoves(out);
    return out;
  };
}
