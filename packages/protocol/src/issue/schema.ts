import { Schema } from "effect";

import type { Codec } from "../codec";
import { IssueId, Outcome, SessionId, Spent } from "../common/schema";
import { Commit, UncommittedItem } from "../repo/schema";
import { IssueAnswer, PhaseResting, Session } from "../session/schema";
import * as T from "../shapes";

export const Conflict: Codec<T.Conflict> = Schema.Struct({
  base: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
});
export const Delivery: Codec<T.Delivery> = Schema.Literals(T.DeliveryValues);
export const IssueCanceled: Codec<T.IssueCanceled> = Schema.Literals(T.IssueCanceledValues);

export const Priority: Codec<T.Priority> = Schema.Literals(T.PriorityValues);

export const IssueStatus: Codec<T.IssueStatus> = Schema.Literals(T.IssueStatusValues);

export const PullRequestState: Codec<T.PullRequestState> = Schema.Literals(T.PullRequestStateValues);

export const PullRequest: Codec<T.PullRequest> = Schema.Struct({
  url: Schema.String,
  number: Schema.Finite,
  state: PullRequestState,
});

export const Finding: Codec<T.Finding> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  resolved: Schema.Boolean,
});

export const IssueRefining: Codec<T.IssueRefining> = Schema.Struct({
  session: SessionId,
  name: Schema.String,
});

export const Question: Codec<T.Question> = Schema.Struct({
  question: Schema.String,
  options: Schema.mutable(Schema.Array(Schema.String)),
});

export const CheckResult: Codec<T.CheckResult> = Schema.Literals(T.CheckResultValues);

export const CriterionCheck: Codec<T.CriterionCheck> = Schema.Struct({
  criterion: Schema.Finite,
  result: CheckResult,
  proof: Schema.String,
});

export const IssueStageKind: Codec<T.IssueStageKind> = Schema.Literals(T.IssueStageKindValues);
export const StuckReason: Codec<T.StuckReason> = Schema.Literals(T.StuckReasonValues);
export const IssueAct: Codec<T.IssueAct> = Schema.Literals(T.IssueActValues);

export const ActWords: Codec<T.ActWords> = Schema.Literals(T.ActWordsValues);

export const IssueAction: Codec<T.IssueAction> = Schema.Union([
  Schema.Struct({ act: IssueAct, does: Schema.Literal("move"), status: IssueStatus, words: ActWords }),
  Schema.Struct({ act: IssueAct, does: Schema.Literal("say") }),
  Schema.Struct({ act: IssueAct, does: Schema.Literal("stop") }),
]);

export const IssueStage: Codec<T.IssueStage> = Schema.Struct({
  state: IssueStageKind,
  since: Schema.optionalKey(Schema.Finite),
  stuck: Schema.optionalKey(StuckReason),
  lead: Schema.optionalKey(IssueAct),
  acts: Schema.mutable(Schema.Array(IssueAction)),
});

export const MilestoneKind: Codec<T.MilestoneKind> = Schema.Literals(T.MilestoneKindValues);

export const Milestone: Codec<T.Milestone> = Schema.Struct({
  at: Schema.Finite,
  kind: MilestoneKind,
  who: Schema.optionalKey(Schema.String),
  text: Schema.String,
});

export const IssueTimeline: Codec<T.IssueTimeline> = Schema.Struct({
  milestones: Schema.mutable(Schema.Array(Milestone)),
  spent: Schema.optionalKey(Spent),
});

export const Deliverable: Codec<T.Deliverable> = Schema.Literals(T.DeliverableValues);

export const Assignment: Codec<T.Assignment> = Schema.Struct({
  id: Schema.String,
  issue: IssueId,
  agent: Schema.String,
  assignedAt: Schema.Finite,
  endedAt: Schema.optionalKey(Schema.Finite),
  executions: Schema.mutable(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("worker"), session: SessionId, startedAt: Schema.Finite }),
        Schema.Struct({ kind: Schema.Literal("orchestrator"), session: Schema.String, startedAt: Schema.Finite }),
      ]),
    ),
  ),
});

export const MandateStrength: Codec<T.MandateStrength> = Schema.Literals(T.MandateStrengthValues);

export const IssueMandate: Codec<T.IssueMandate> = Schema.Struct({
  originTriggerId: Schema.optionalKey(Schema.String),
  strength: MandateStrength,
  maxBotReviewRounds: Schema.Int,
  autoSubmitPr: Schema.Boolean,
});

export const IssueReportMemory: Codec<T.IssueReportMemory> = Schema.Struct({ text: Schema.String, scope: Schema.Literals(["repo", "all"]) });

export const IssueReport: Codec<T.IssueReport> = Schema.Struct({
  summary: Schema.String,
  questions: Schema.mutable(Schema.Array(Question)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
  remember: Schema.mutable(Schema.Array(IssueReportMemory)),
  prSubmit: Schema.Boolean,
  answer: Schema.optionalKey(IssueAnswer),
});

export const IssueConstraints: Codec<T.IssueConstraints> = Schema.Struct({
  check: Schema.optionalKey(Schema.String),
  scope: Schema.mutable(Schema.Array(Schema.String)),
  acceptance: Schema.Boolean,
  frozen: Schema.mutable(Schema.Array(Schema.String)),
});

const issueFields = {
  constraints: Schema.optionalKey(IssueConstraints),
  id: IssueId,
  number: Schema.Finite,
  title: Schema.String,
  description: Schema.String,
  mandate: IssueMandate,
  conflict: Schema.optionalKey(Conflict),
  repo: Schema.optionalKey(Schema.String),
  assignments: Schema.mutable(Schema.Array(Assignment)),
  priority: Priority,
  rank: Schema.optionalKey(Schema.Finite),
  createdAt: Schema.Finite,
  queuedAt: Schema.optionalKey(Schema.Finite),
  closedAt: Schema.optionalKey(Schema.Finite),
  delivered: Schema.optionalKey(Delivery),
  canceled: Schema.optionalKey(IssueCanceled),
  parent: Schema.optionalKey(IssueId),
  blockedBy: Schema.mutable(Schema.Array(Schema.String)),
  cron: Schema.optionalKey(Schema.String),
  status: IssueStatus,
  moves: Schema.mutable(Schema.Array(IssueStatus)),
  pullRequest: Schema.optionalKey(PullRequest),
  deliver: Deliverable,
  reviewedAt: Schema.optionalKey(Schema.Finite),
  findings: Schema.mutable(Schema.Array(Finding)),
  questions: Schema.mutable(Schema.Array(Question)),
  criteria: Schema.mutable(Schema.Array(Schema.String)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
  refining: Schema.optionalKey(IssueRefining),
  lastRun: Schema.optionalKey(
    Schema.Struct({
      startedAt: Schema.Finite,
      endedAt: Schema.optionalKey(Schema.Finite),
      outcome: Schema.optionalKey(Outcome),
    }),
  ),
  answer: Schema.optionalKey(IssueAnswer),
  stage: IssueStage,
};

export const Issue: Codec<T.Issue> = Schema.Struct(issueFields);

export const AppliedIssue: Codec<T.AppliedIssue> = Schema.Struct({ ...issueFields, seq: Schema.Finite });

export const IssueUpdate: Codec<T.IssueUpdate> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  deliver: Schema.optionalKey(Deliverable),
  before: Schema.optionalKey(Schema.String),
});

export const ChangedFile: Codec<T.ChangedFile> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Finite,
  removed: Schema.Finite,
  patch: Schema.optionalKey(Schema.String),
});

export const Changes: Codec<T.Changes> = Schema.Struct({
  repo: Schema.String,
  base: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  commits: Schema.mutable(Schema.Array(Commit)),
  files: Schema.mutable(Schema.Array(ChangedFile)),
  uncommitted: Schema.mutable(Schema.Array(UncommittedItem)),
  conflicts: Schema.mutable(Schema.Array(Schema.String)),
  behind: Schema.Finite,
});

export const IssueHistory: Codec<T.IssueHistory> = Schema.Struct({
  issue: Issue,
  sessions: Schema.mutable(Schema.Array(Session)),
  missingSessions: Schema.mutable(Schema.Array(SessionId)),
});

export const IssueRefineRequest: Codec<T.IssueRefineRequest> = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
});

export const IssueRequest: Codec<T.IssueRequest> = Schema.Struct({
  constraints: Schema.optionalKey(IssueConstraints),
  title: Schema.String,
  parent: Schema.optionalKey(IssueId),
  blockedBy: Schema.optionalKey(Schema.mutable(Schema.Array(IssueId))),
  description: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Priority),
  deliver: Schema.optionalKey(Deliverable),
  autoSubmitPr: Schema.optionalKey(Schema.Boolean),
  criteria: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  requestKey: Schema.optionalKey(Schema.String),
});

export const CommentRequest: Codec<T.CommentRequest> = Schema.Struct({
  text: Schema.String,
  sendKey: Schema.optionalKey(Schema.String),
});

export const IssueReviewRequest: Codec<T.IssueReviewRequest> = Schema.Struct({
  pass: Schema.Boolean,
  findings: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  text: Schema.optionalKey(Schema.String),
});

export const IssueFilter: Codec<T.IssueFilter> = Schema.Struct({
  status: Schema.optionalKey(IssueStatus),
  text: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Finite),
  closed: Schema.optionalKey(Schema.Boolean),
  wantsOwner: Schema.optionalKey(Schema.Boolean),
});

export const IssueChildDraft: Codec<T.IssueChildDraft> = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  brief: Schema.String,
  needs: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  acceptance: Schema.optionalKey(Schema.Boolean),
});

export const IssueSplitRequest: Codec<T.IssueSplitRequest> = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  tasks: Schema.mutable(Schema.Array(IssueChildDraft)),
});

export const IssueStatusRequest: Codec<T.IssueStatusRequest> = Schema.Struct({
  status: IssueStatus,
  text: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  edit: Schema.optionalKey(IssueUpdate),
  requestKey: Schema.optionalKey(Schema.String),
});

export const FactSessionReported: Codec<T.FactSessionReported> = Schema.Struct({
  type: Schema.Literal("sessionReported"),
  at: Schema.Finite,
  id: SessionId,
  run: Schema.optionalKey(Schema.String),
  outcome: Outcome,
  phase: Schema.optionalKey(PhaseResting),
  summary: Schema.String,
  runs: Schema.Finite,
  spent: Schema.optionalKey(Spent),
  questions: Schema.mutable(Schema.Array(Question)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
  answer: Schema.optionalKey(IssueAnswer),
});

export const FactIssueChanged: Codec<T.FactIssueChanged> = Schema.Struct({
  type: Schema.Literal("issueChanged"),
  at: Schema.Finite,
  issue: Issue,
});

export const FactIssueRemoved: Codec<T.FactIssueRemoved> = Schema.Struct({
  type: Schema.Literal("issueRemoved"),
  at: Schema.Finite,
  id: IssueId,
});
