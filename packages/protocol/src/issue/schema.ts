import { z } from "zod";

import type { Codec } from "../codec";
import { IssueId, Outcome, SessionId, Spent } from "../common/schema";
import { Conflict } from "../repo/schema";
import { IssueAnswer, PhaseResting, Session, SessionEvent } from "../session/schema";
import * as T from "./shapes";
import { IssueReportMemoryScopeValues } from "./shapes";

const Landing = z.enum(T.LandingValues) satisfies Codec<T.Landing>;
const IssueCanceled = z.enum(T.IssueCanceledValues) satisfies Codec<T.IssueCanceled>;

const Priority = z.enum(T.PriorityValues) satisfies Codec<T.Priority>;

export const IssueStatus = z.enum(T.IssueStatusValues) satisfies Codec<T.IssueStatus>;

const PullRequestState = z.enum(T.PullRequestStateValues) satisfies Codec<T.PullRequestState>;

export const PullRequest = z.object({
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

export const IssueReportMemory = z.object({ text: z.string(), scope: z.enum(IssueReportMemoryScopeValues) }) satisfies Codec<T.IssueReportMemory>;

export const IssueReport = z.object({
  summary: z.string(),
  questions: z.array(Question),
  checks: z.array(CriterionCheck),
  remember: z.array(IssueReportMemory),
  prSubmit: z.boolean(),
  answer: z.exactOptional(IssueAnswer),
}) satisfies Codec<T.IssueReport>;

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
};

export const Issue = z.object(issueFields) satisfies Codec<T.Issue>;

export const AppliedIssue = z.object({ ...issueFields, seq: z.number() }) satisfies Codec<T.AppliedIssue>;

export const IssueUpdate = z.object({
  title: z.exactOptional(z.string()),
  description: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  priority: z.exactOptional(Priority),
  criteria: z.exactOptional(z.array(z.string())),
  deliver: z.exactOptional(Deliverable),
  before: z.exactOptional(z.string()),
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
  priority: z.exactOptional(Priority),
  deliver: z.exactOptional(Deliverable),
  autoSubmitPr: z.exactOptional(z.boolean()),
  criteria: z.exactOptional(z.array(z.string())),
  requestKey: z.exactOptional(z.string()),
}) satisfies Codec<T.IssueRequest>;

export const CommentRequest = z.object({
  text: z.string(),
  sendKey: z.exactOptional(z.string()),
}) satisfies Codec<T.CommentRequest>;

export const IssueReviewRequest = z.object({
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
  status: IssueStatus,
  text: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  edit: z.exactOptional(IssueUpdate),
  requestKey: z.exactOptional(z.string()),
}) satisfies Codec<T.IssueStatusRequest>;

export const FactSessionReported = z.object({
  type: z.literal("sessionReported"),
  at: z.number(),
  id: SessionId,
  run: z.exactOptional(z.string()),
  outcome: Outcome,
  phase: z.exactOptional(PhaseResting),
  summary: z.string(),
  runs: z.number(),
  spent: z.exactOptional(Spent),
  questions: z.array(Question),
  checks: z.array(CriterionCheck),
  answer: z.exactOptional(IssueAnswer),
}) satisfies Codec<T.FactSessionReported>;

export const FactIssueChanged = z.object({
  type: z.literal("issueChanged"),
  at: z.number(),
  issue: Issue,
}) satisfies Codec<T.FactIssueChanged>;

export const FactIssueRemoved = z.object({
  type: z.literal("issueRemoved"),
  at: z.number(),
  id: IssueId,
}) satisfies Codec<T.FactIssueRemoved>;

export const IssueWatch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("history"), session: SessionId, events: z.array(SessionEvent) }),
  z.object({
    kind: z.literal("state"),
    issue: Issue,
    sessions: z.array(Session),
    sessionIds: z.array(SessionId),
    settled: z.boolean(),
    omittedSessions: z.number().int(),
  }),
  z.object({ kind: z.literal("event"), session: SessionId, event: SessionEvent }),
  z.object({ kind: z.literal("gap"), session: SessionId, before: z.exactOptional(z.number().int()) }),
  z.object({ kind: z.literal("missing"), issue: IssueId }),
]) satisfies Codec<T.IssueWatch>;
