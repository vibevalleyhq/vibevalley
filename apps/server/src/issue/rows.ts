import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "@/base/json.ts";
import { type Core } from "@/core/core.ts";

import type * as q from "../../db/generated/issue.sql.ts";
import { attentionIn } from "./attention.ts";
import { statusMoves } from "./moves.ts";
import { issueRefiningOf, issueStatusOf } from "./status.ts";

type Row = q.GetIssueResult;
const strings = Schema.mutable(Schema.Array(Schema.String));
export const column = {
  graph: jsonOrNone(S.IssueGraph),
  task: jsonOrNone(S.IssueTask),
  strings: jsonOrNone(strings),
  checks: jsonOrNone(Schema.mutable(Schema.Array(S.CriterionCheck))),
  pullRequest: jsonOrNone(S.PullRequest),
  run: jsonOrNone(S.IssueRun),
  answer: jsonOrNone(S.IssueAnswer),
  findings: jsonOrNone(Schema.mutable(Schema.Array(S.Finding))),
  questions: jsonOrNone(Schema.mutable(Schema.Array(S.Question))),
};

export function issueRows(core: Core["Service"]) {
  return function issueOf(row: Row, runs: readonly string[] | undefined): T.Issue {
    const state = core.state();
    const graph = column.graph(row.graph);
    const task = column.task(row.task);
    const blockedBy = column.strings(row.blocked_by);
    const criteria = column.strings(row.criteria);
    const checks = column.checks(row.checks);
    const pullRequest = column.pullRequest(row.pull_request);
    const lastRun = column.run(row.last_run);
    const answer = column.answer(row.answer);
    const out: T.Issue = {
      id: issueId(row.id),
      number: row.number,
      title: row.title,
      description: row.description,
      ...(row.project !== null ? { project: row.project } : {}),
      ...(row.assignee !== null ? { assignee: row.assignee } : {}),
      priority: row.priority,
      createdAt: row.created_at,
      ...(row.queued_at !== null ? { queuedAt: row.queued_at } : {}),
      sessions: (runs ?? []).map((s) => sessionId(s)),
      ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
      ...(row.delivered !== null ? { delivered: row.delivered } : {}),
      ...(row.canceled !== null ? { canceled: row.canceled } : {}),
      ...(row.parent !== null ? { parent: issueId(row.parent) } : {}),
      blockedBy: blockedBy ?? [],
      ...(graph ? { graph } : {}),
      ...(task ? { task } : {}),
      ...(row.cron !== null ? { cron: row.cron } : {}),
      status: "backlog",
      moves: [],
      ...(pullRequest ? { pullRequest } : {}),
      deliver: row.deliver,
      ...(row.talk !== null ? { talk: row.talk } : {}),
      ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
      findings: column.findings(row.findings) ?? [],
      questions: column.questions(row.questions) ?? [],
      criteria: criteria ?? [],
      checks: checks ?? [],
      ...(lastRun ? { lastRun } : {}),
      ...(answer ? { answer } : {}),
      attention: { state: "draft", acts: [] },
    };
    if ((out.sessions.length === 0 || out.task) && row.rank !== 0) out.rank = row.rank;
    out.status = issueStatusOf(out, state);
    const refiner = issueRefiningOf(out, state);
    if (refiner) out.refining = refiner;
    // The moves read the attention: a round that failed is not completed.
    out.attention = attentionIn(out, state);
    out.moves = statusMoves(out);
    return out;
  };
}
