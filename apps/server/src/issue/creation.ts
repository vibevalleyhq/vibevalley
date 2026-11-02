import type * as T from "@vibevalley/protocol";

import type { AddIssueParams } from "../../db/generated/issue.sql.ts";

export const maxChildren = 12;

export const issueRow = (id: string, req: T.IssueRequest, mandate: T.IssueMandate, at: number, cron?: string): AddIssueParams => ({
  id,
  title: req.title,
  description: req.description ?? "",
  origin_trigger_id: mandate.originTriggerId ?? null,
  mandate_strength: mandate.strength,
  max_bot_review_rounds: mandate.maxBotReviewRounds,
  auto_submit_pr: mandate.autoSubmitPr,
  project: req.project?.trim() || null,
  parent: req.parent ?? null,
  blocked_by: (req.blockedBy?.length ?? 0) > 0 ? JSON.stringify(req.blockedBy) : null,
  constraints: req.constraints ? JSON.stringify(req.constraints) : null,
  priority: req.priority ?? "medium",
  created_at: at,
  cron: cron ?? null,
  deliver: req.deliver ?? "change",
});
