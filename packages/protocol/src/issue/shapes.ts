import type { IssueId, Outcome, SessionId, Spent } from "../common/shapes";
import type { Conflict } from "../repo/shapes";
import type { IssueAnswer, PhaseResting, Run, Session, SessionEvent } from "../session/shapes";

/** Retained across execution contexts and ended only by reassignment or unassignment. */
export interface Assignment {
  id: string;
  issue: IssueId;
  agent: string;
  assignedAt: number;
  endedAt?: number;
  executions: ({ kind: "worker"; session: SessionId; startedAt: number } | { kind: "orchestrator"; session: string; startedAt: number })[];
}

export interface IssueHistory {
  issue: Issue;
  sessions: Session[];
  missingSessions: SessionId[];
}

export const PullRequestStateValues = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PullRequestStateValues)[number];

export interface PullRequest {
  url: string;
  number: number;
  state: PullRequestState;
}

export const MandateStrengthValues = ["explicit", "inferred"] as const;
export type MandateStrength = (typeof MandateStrengthValues)[number];

export interface IssueMandate {
  originTriggerId?: string;
  strength: MandateStrength;
  maxBotReviewRounds: number;
  autoSubmitPr: boolean;
}

export const IssueReportMemoryScopeValues = ["repo", "all"] as const;
type IssueReportMemoryScope = (typeof IssueReportMemoryScopeValues)[number];

export interface IssueReportMemory {
  text: string;
  scope: IssueReportMemoryScope;
}

export interface IssueReport {
  summary: string;
  questions: Question[];
  checks: CriterionCheck[];
  remember: IssueReportMemory[];
  prSubmit: boolean;
  answer?: IssueAnswer;
}

export interface IssueConstraints {
  check?: string;
  scope: string[];
  acceptance: boolean;
  frozen: string[];
}

export interface Issue {
  id: IssueId;
  number: number;
  title: string;
  description: string;
  mandate: IssueMandate;
  constraints?: IssueConstraints;
  conflict?: Conflict;
  repo?: string;
  assignments: Assignment[];
  priority: Priority;
  rank?: number;
  createdAt: number;
  queuedAt?: number;
  closedAt?: number;
  delivered?: Delivery;
  canceled?: IssueCanceled;
  parent?: IssueId;
  blockedBy: IssueId[];
  cron?: string;
  status: IssueStatus;
  moves: IssueStatus[];
  pullRequest?: PullRequest;
  deliver: Deliverable;
  reviewedAt?: number;
  findings: Finding[];
  questions: Question[];
  criteria: string[];
  checks: CriterionCheck[];
  refining?: IssueRefining;
  /** Tracks runs executed without a worker session (e.g. in-process orchestrator); active while `endedAt` is absent. */
  lastRun?: Pick<Run, "startedAt" | "endedAt" | "outcome">;
  answer?: IssueAnswer;
  stage: IssueStage;
}

/** Includes the Core fold `seq` that applied the mutation so clients can await state convergence. */
export interface AppliedIssue extends Issue {
  seq: number;
}

export interface Question {
  question: string;
  options: string[];
}

export const CheckResultValues = ["met", "unmet", "unsure"] as const;
export type CheckResult = (typeof CheckResultValues)[number];

export interface CriterionCheck {
  /** 0-based index into `Issue.criteria`. */
  criterion: number;
  result: CheckResult;
  proof: string;
}

export const IssueStageKindValues = ["draft", "queued", "working", "asking", "reviewing", "stuck", "done", "canceled"] as const;
export type IssueStageKind = (typeof IssueStageKindValues)[number];

export const StuckReasonValues = ["failed", "conflict", "interrupted", "quiet"] as const;
export type StuckReason = (typeof StuckReasonValues)[number];

export const IssueActValues = ["start", "answer", "reject", "complete", "acknowledge", "resolve", "resume", "cure", "tell", "stop", "close", "reopen"] as const;
export type IssueAct = (typeof IssueActValues)[number];

export interface IssueStage {
  state: IssueStageKind;
  since?: number;
  stuck?: StuckReason;
  /** Primary action highlighted for the user, if any. */
  lead?: IssueAct;
  acts: IssueAction[];
}

/** `move` dispatches `issue.status.update`, `say` dispatches `issue.comment.create`, `stop` dispatches `session.stop`. */
export type IssueAction =
  | { readonly act: IssueAct; readonly does: "move"; readonly status: IssueStatus; readonly words: ActWords }
  | { readonly act: IssueAct; readonly does: "say" }
  | { readonly act: IssueAct; readonly does: "stop" };

export const ActWordsValues = ["none", "optional", "required"] as const;
export type ActWords = (typeof ActWordsValues)[number];

export const MilestoneKindValues = [
  "opened",
  "refined",
  "started",
  "reported",
  "asked",
  "told",
  "failed",
  "stopped",
  "rejected",
  "accepted",
  "closed",
] as const;
export type MilestoneKind = (typeof MilestoneKindValues)[number];

export interface Milestone {
  at: number;
  kind: MilestoneKind;
  /** Session name; absent for user or system milestones. */
  who?: string;
  text: string;
}

export interface IssueTimeline {
  milestones: Milestone[];
  spent?: Spent;
}

export interface IssueRefining {
  session: SessionId;
  name: string;
}

export interface IssueRefineRequest {
  text?: string;
  /** Unsaved field edits applied atomically before refining starts. */
  edit?: IssueUpdate;
}

export const IssueStatusValues = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueStatus = (typeof IssueStatusValues)[number];

export const PriorityValues = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PriorityValues)[number];

export interface IssueUpdate {
  title?: string;
  description?: string;
  repo?: string;
  agent?: string;
  priority?: Priority;
  criteria?: string[];
  deliver?: Deliverable;
  /** Board placement before this issue id; "" places it last. Valid only before dispatch. */
  before?: string;
}

export interface Finding {
  id: string;
  text: string;
  at: number;
  resolved: boolean;
}

export interface IssueRequest {
  title: string;
  parent?: IssueId;
  blockedBy?: IssueId[];
  constraints?: IssueConstraints;
  description?: string;
  repo?: string;
  agent?: string;
  priority?: Priority;
  deliver?: Deliverable;
  autoSubmitPr?: boolean;
  criteria?: string[];
  /** Idempotency key deduplicating retries after a lost response. */
  requestKey?: string;
}

export const DeliverableValues = ["change", "branch", "answer", "pull_request"] as const;
export type Deliverable = (typeof DeliverableValues)[number];

export const DeliveryValues = ["merged", "merged_into_parent", "pull_request", "submitted", "kept", "none"] as const;
export type Delivery = (typeof DeliveryValues)[number];

export const IssueCanceledValues = ["dismissed", "lost"] as const;
export type IssueCanceled = (typeof IssueCanceledValues)[number];

export interface CommentRequest {
  text: string;
  sendKey?: string;
}

export interface IssueReviewRequest {
  pass: boolean;
  findings?: string[];
  text?: string;
}

export interface IssueFilter {
  /** Includes closed issues when set to `done` or `canceled`. */
  status?: IssueStatus;
  text?: string;
  repo?: string;
  limit?: number;
  closed?: boolean;
  /** Filters to issues waiting on the user, ordered longest-waiting first. */
  wantsUser?: boolean;
}

export interface IssueChildDraft {
  id: string;
  title?: string;
  brief: string;
  needs?: string[];
  /** Profile id or name; "" lets the server assign one. */
  agent?: string;
  check?: string;
  scope?: string[];
  acceptance?: boolean;
}

export interface IssueSplitRequest {
  title?: string;
  tasks: IssueChildDraft[];
}

export interface IssueStatusRequest {
  status: IssueStatus;
  /** Follow-up instructions or review findings when moving back to `todo`. */
  text?: string;
  agent?: string;
  /** Unsaved field edits applied atomically before the status transition. */
  edit?: IssueUpdate;
  /** Idempotency key deduplicating retries after a lost response. */
  requestKey?: string;
}

export interface FactSessionReported {
  type: "sessionReported";
  at: number;
  id: SessionId;
  run?: string;
  outcome: Outcome;
  /** Set when a turn rests waiting on external feedback without handing off to the user. */
  phase?: PhaseResting;
  summary: string;
  runs: number;
  spent?: Spent;
  questions: Question[];
  checks: CriterionCheck[];
  answer?: IssueAnswer;
}

export interface FactIssueChanged {
  type: "issueChanged";
  at: number;
  issue: Issue;
}

export interface FactIssueRemoved {
  type: "issueRemoved";
  at: number;
  id: IssueId;
}

export type IssueWatch =
  | { kind: "history"; session: string; events: SessionEvent[] }
  | { kind: "state"; issue: Issue; sessions: Session[]; sessionIds: string[]; settled: boolean; omittedSessions: number }
  | { kind: "event"; session: string; event: SessionEvent }
  | { kind: "gap"; session: string; before?: number }
  | { kind: "missing"; issue: string };
