import { z } from "zod";

import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import { IssueId, Outcome, SessionId, Spent } from "../common/schema";
import { Conflict, ReviewRevision } from "../repo/schema";
import { IssueAnswer, Session } from "../session/schema";
import * as T from "./shapes.gen";

const Landing = z.enum(T.LandingValues) satisfies Codec<T.Landing>;
const IssueCanceled = z.enum(T.IssueCanceledValues) satisfies Codec<T.IssueCanceled>;

const Priority = z.enum(T.PriorityValues) satisfies Codec<T.Priority>;

export const IssueStatus = z.enum(T.IssueStatusValues) satisfies Codec<T.IssueStatus>;

export const IssueLane = z.enum(T.IssueLaneValues) satisfies Codec<T.IssueLane>;

const IssueCardKind = z.enum(T.IssueCardKindValues) satisfies Codec<T.IssueCardKind>;

export const IssuePromptKind = z.enum(T.IssuePromptKindValues) satisfies Codec<T.IssuePromptKind>;

export const BoardLaneCounts = z.object({
  backlog: z.number(),
  todo: z.number(),
  inProgress: z.number(),
  inReview: z.number(),
  done: z.number(),
  canceled: z.number(),
}) satisfies Codec<T.BoardLaneCounts>;

export const BoardIssueSummary = z.object({
  lane: IssueLane,
  cardKind: IssueCardKind,
  familyDone: z.number(),
  familyTotal: z.number(),
  needsWorktreeCheck: z.boolean(),
  prompt: z.exactOptional(IssuePromptKind),
}) satisfies Codec<T.BoardIssueSummary>;

export const BoardSummary = z.object({
  laneCounts: BoardLaneCounts,
  runningSlots: z.number(),
  maxRunning: z.number(),
  byIssue: z.record(z.string(), BoardIssueSummary),
}) satisfies Codec<T.BoardSummary>;

const PullRequestState = z.enum(T.PullRequestStateValues) satisfies Codec<T.PullRequestState>;

const PullRequest = z.object({
  url: z.string(),
  number: z.number(),
  state: PullRequestState,
}) satisfies Codec<T.PullRequest>;

export const Finding = z.object({
  id: z.string(),
  text: z.string(),
  at: z.number(),
  resolved: z.boolean(),
}) satisfies Codec<T.Finding>;

const IssueRefining = z.object({
  session: SessionId,
  name: z.string(),
}) satisfies Codec<T.IssueRefining>;

export const Question = z.object({
  question: z.string(),
  options: z.array(z.string()),
}) satisfies Codec<T.Question>;

const CheckResult = z.enum(T.CheckResultValues) satisfies Codec<T.CheckResult>;

export const CriterionCheck = z.object({
  criterion: z.number(),
  result: CheckResult,
  proof: z.string(),
}) satisfies Codec<T.CriterionCheck>;

export const IssueStageKind = z.enum(T.IssueStageKindValues) satisfies Codec<T.IssueStageKind>;
const StuckReason = z.enum(T.StuckReasonValues) satisfies Codec<T.StuckReason>;
const IssueAct = z.enum(T.IssueActValues) satisfies Codec<T.IssueAct>;

const ActWords = z.enum(T.ActWordsValues) satisfies Codec<T.ActWords>;

const IssueAction = z.discriminatedUnion("does", [
  z.object({ act: IssueAct, does: z.literal("move"), status: IssueStatus, words: ActWords }),
  z.object({ act: IssueAct, does: z.literal("say") }),
  z.object({ act: IssueAct, does: z.literal("stop") }),
]) satisfies Codec<T.IssueAction>;

const IssueStage = z.object({
  state: IssueStageKind,
  since: z.exactOptional(z.number()),
  stuck: z.exactOptional(StuckReason),
  lead: z.exactOptional(IssueAct),
  acts: z.array(IssueAction),
}) satisfies Codec<T.IssueStage>;

const MilestoneKind = z.enum(T.MilestoneKindValues) satisfies Codec<T.MilestoneKind>;

const Milestone = z.object({
  at: z.number(),
  kind: MilestoneKind,
  who: z.exactOptional(z.string()),
  text: z.string(),
}) satisfies Codec<T.Milestone>;

export const IssueTimeline = z.object({
  milestones: z.array(Milestone),
  spent: z.exactOptional(Spent),
}) satisfies Codec<T.IssueTimeline>;

const Deliverable = z.enum(T.DeliverableValues) satisfies Codec<T.Deliverable>;

const Assignment = z.object({
  id: z.string(),
  issue: IssueId,
  agent: z.string(),
  assignedAt: z.number(),
  endedAt: z.exactOptional(z.number()),
  executions: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("worker"), session: SessionId, startedAt: z.number() }),
      z.object({ kind: z.literal("orchestrator"), session: z.string(), startedAt: z.number() }),
    ]),
  ),
}) satisfies Codec<T.Assignment>;

const MandateStrength = z.enum(T.MandateStrengthValues) satisfies Codec<T.MandateStrength>;

const IssueMandate = z.object({
  originTriggerId: z.exactOptional(z.string()),
  strength: MandateStrength,
  maxBotReviewRounds: z.number().int(),
  autoSubmitPr: z.boolean(),
}) satisfies Codec<T.IssueMandate>;

export const IssueConstraints = z.object({
  check: z.exactOptional(z.string()),
  scope: z.array(z.string()),
  acceptance: z.boolean(),
  frozen: z.array(z.string()),
}) satisfies Codec<T.IssueConstraints>;

const issueFields = {
  constraints: z.exactOptional(IssueConstraints),
  id: IssueId,
  number: z.number(),
  title: z.string(),
  description: z.string(),
  mandate: IssueMandate,
  conflict: z.exactOptional(Conflict),
  repo: z.exactOptional(z.string()),
  machineId: z.exactOptional(z.string()),
  assignments: z.array(Assignment),
  priority: Priority,
  rank: z.exactOptional(z.number()),
  createdAt: z.number(),
  queuedAt: z.exactOptional(z.number()),
  closedAt: z.exactOptional(z.number()),
  delivered: z.exactOptional(Landing),
  canceled: z.exactOptional(IssueCanceled),
  parent: z.exactOptional(IssueId),
  blockedBy: z.array(IssueId),
  cron: z.exactOptional(z.string()),
  status: IssueStatus,
  moves: z.array(IssueStatus),
  pullRequest: z.exactOptional(PullRequest),
  deliver: Deliverable,
  reviewedAt: z.exactOptional(z.number()),
  deliveryEvidence: z.exactOptional(
    z.object({
      reviews: z.array(z.object({ at: z.number(), revision: ReviewRevision })),
      check: z.exactOptional(
        z.object({
          targetBranch: z.string(),
          targetCommit: z.string(),
          sourceTree: z.string(),
          candidateCommit: z.string(),
          candidateTree: z.string(),
          status: z.enum(T.ProjectCheckStatusValues),
          command: z.exactOptional(z.string()),
          output: z.exactOptional(z.string()),
        }),
      ),
      mergedCommit: z.exactOptional(z.string()),
    }),
  ),
  findings: z.array(Finding),
  questions: z.array(Question),
  criteria: z.array(z.string()),
  checks: z.array(CriterionCheck),
  refining: z.exactOptional(IssueRefining),
  lastRun: z.exactOptional(
    z.object({
      startedAt: z.number(),
      endedAt: z.exactOptional(z.number()),
      outcome: z.exactOptional(Outcome),
    }),
  ),
  answer: z.exactOptional(IssueAnswer),
  stage: IssueStage,
  attachments: z.exactOptional(z.array(Attachment)),
  tags: z.exactOptional(z.array(z.string())),
  startAt: z.exactOptional(z.number()),
  dueAt: z.exactOptional(z.number()),
};

export const Issue = z.object(issueFields) satisfies Codec<T.Issue>;

export const AppliedIssue = z.object({ ...issueFields, seq: z.number() }) satisfies Codec<T.AppliedIssue>;

export const IssueUpdate = z.object({
  title: z.exactOptional(z.string()),
  description: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  machineId: z.exactOptional(z.string()),
  priority: z.exactOptional(Priority),
  criteria: z.exactOptional(z.array(z.string())),
  deliver: z.exactOptional(Deliverable),
  before: z.exactOptional(z.string()),
  attachments: z.exactOptional(z.array(z.string())),
  parent: z.exactOptional(z.string()),
  tags: z.exactOptional(z.array(z.string())),
  startAt: z.exactOptional(z.number()),
  dueAt: z.exactOptional(z.number()),
}) satisfies Codec<T.IssueUpdate>;

export const IssueHistory = z.object({
  issue: Issue,
  sessions: z.array(Session),
  missingSessions: z.array(SessionId),
}) satisfies Codec<T.IssueHistory>;

export const IssueRefineRequest = z.object({
  text: z.exactOptional(z.string()),
  edit: z.exactOptional(IssueUpdate),
}) satisfies Codec<T.IssueRefineRequest>;

export const IssueRequest = z.object({
  constraints: z.exactOptional(IssueConstraints),
  title: z.string(),
  parent: z.exactOptional(IssueId),
  blockedBy: z.exactOptional(z.array(IssueId)),
  description: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  machineId: z.exactOptional(z.string()),
  priority: z.exactOptional(Priority),
  deliver: z.exactOptional(Deliverable),
  autoSubmitPr: z.exactOptional(z.boolean()),
  criteria: z.exactOptional(z.array(z.string())),
  attachments: z.exactOptional(z.array(z.string())),
  tags: z.exactOptional(z.array(z.string())),
  startAt: z.exactOptional(z.number()),
  dueAt: z.exactOptional(z.number()),
  requestKey: z.exactOptional(z.string()),
}) satisfies Codec<T.IssueRequest>;

export const CommentRequest = z.object({
  text: z.string(),
  sendKey: z.exactOptional(z.string()),
}) satisfies Codec<T.CommentRequest>;

export const IssueReviewRequest = z.object({
  revision: z.exactOptional(ReviewRevision),
  pass: z.boolean(),
  findings: z.exactOptional(z.array(z.string())),
  text: z.exactOptional(z.string()),
}) satisfies Codec<T.IssueReviewRequest>;

export const IssueFilter = z.object({
  status: z.exactOptional(IssueStatus),
  text: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  limit: z.exactOptional(z.number()),
  closed: z.exactOptional(z.boolean()),
  wantsUser: z.exactOptional(z.boolean()),
}) satisfies Codec<T.IssueFilter>;

const IssueChildDraft = z.object({
  id: z.string(),
  title: z.exactOptional(z.string()),
  brief: z.string(),
  needs: z.exactOptional(z.array(z.string())),
  agent: z.exactOptional(z.string()),
  check: z.exactOptional(z.string()),
  scope: z.exactOptional(z.array(z.string())),
  acceptance: z.exactOptional(z.boolean()),
}) satisfies Codec<T.IssueChildDraft>;

export const IssueSplitRequest = z.object({
  title: z.exactOptional(z.string()),
  tasks: z.array(IssueChildDraft),
}) satisfies Codec<T.IssueSplitRequest>;

export const IssueStatusRequest = z.object({
  revision: z.exactOptional(ReviewRevision),
  status: IssueStatus,
  text: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  edit: z.exactOptional(IssueUpdate),
  requestKey: z.exactOptional(z.string()),
}) satisfies Codec<T.IssueStatusRequest>;
