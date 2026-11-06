import type { IssueId, Outcome, SessionId, Spent } from "../common/shapes";
import type { Commit, UncommittedItem } from "../project/shapes";
import type { IssueAnswer, PhaseResting, Run, Session } from "../session/shapes";

export interface Conflict {
  base: string;
  files: string[];
}

export interface Changes {
  project: string;
  base: string;
  branch?: string;
  commits: Commit[];
  files: ChangedFile[];
  uncommitted: UncommittedItem[];
  conflicts: string[];
  behind: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  patch?: string;
}

/** Responsibility for an issue, retained across execution contexts and ended only by reassignment or unassignment. */
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

export interface IssueReportMemory {
  text: string;
  scope: "project" | "all";
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
  project?: string;
  assignments: Assignment[];
  priority: Priority;
  rank?: number;
  createdAt: number;
  queuedAt?: number;
  closedAt?: number;
  /** Done: what it delivered. Its verdict is the status. */
  delivered?: Delivery;
  /** Canceled: why. */
  canceled?: IssueCanceled;
  parent?: IssueId;
  blockedBy: string[];
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
  /** Its latest run as the issue keeps it, for a run no session on the farm carries (an in-process agent's, the orchestrator's): going on while it has no end. */
  lastRun?: Pick<Run, "startedAt" | "endedAt" | "outcome">;
  /** An answer issue's conclusion, read from what its latest round handed back; none when that round gave none it could read. */
  answer?: IssueAnswer;
  stage: IssueStage;
}

/** An issue as a change left it (issue.create, issue.update, issue.status.update), with the seq of the core's fold that includes the change. */
export interface AppliedIssue extends Issue {
  seq: number;
}

/** A question the helper is waiting on the owner for; options are the answers it thought of, each one a reply as it is. */
export interface Question {
  question: string;
  options: string[];
}

export const CheckResultValues = ["met", "unmet", "unsure"] as const;
export type CheckResult = (typeof CheckResultValues)[number];

/** The helper's own word on one of the criteria, as it handed the work back: criterion is its index in Issue.criteria. */
export interface CriterionCheck {
  criterion: number;
  result: CheckResult;
  proof: string;
}

/** Where an issue stands for the owner, the one set of states the board, the farm and the page all say. */
export const IssueStageKindValues = ["draft", "queued", "working", "asking", "reviewing", "stuck", "done", "canceled"] as const;
export type IssueStageKind = (typeof IssueStageKindValues)[number];

export const StuckReasonValues = ["failed", "conflict", "interrupted", "quiet"] as const;
export type StuckReason = (typeof StuckReasonValues)[number];

/** A button on an issue's page, by what it says. tell is a word to the helper, answer the same to its question. */
export const IssueActValues = ["start", "answer", "reject", "complete", "acknowledge", "resolve", "resume", "cure", "tell", "stop", "close", "reopen"] as const;
export type IssueAct = (typeof IssueActValues)[number];

/** since: when it came to stand so, when known. lead is the one thing the owner is asked to do, if any. */
export interface IssueStage {
  state: IssueStageKind;
  since?: number;
  stuck?: StuckReason;
  lead?: IssueAct;
  acts: IssueAction[];
}

/** What pressing an issue's button sends: move is issue.status.update, say issue.comment.create, stop session.stop. */
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

/** One line of an issue's story; who is the session's name, or absent for the owner and the farm. */
export interface Milestone {
  at: number;
  kind: MilestoneKind;
  who?: string;
  text: string;
}

/** An issue's story newest first, and what all its runs cost. */
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
  /** Fields the owner changed and has not saved: saved first, so the act sees them. */
  edit?: IssueUpdate;
}

export const IssueStatusValues = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueStatus = (typeof IssueStatusValues)[number];

export const PriorityValues = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PriorityValues)[number];

export interface IssueUpdate {
  title?: string;
  description?: string;
  project?: string;
  agent?: string;
  priority?: Priority;
  criteria?: string[];
  deliver?: Deliverable;
  /** Its place on the board: before this issue, or last when empty. Only while it is not sent. */
  before?: string;
}

export interface Finding {
  id: string;
  text: string;
  at: number;
  /** Settled: the next acceptance that passed after it was written. */
  resolved: boolean;
}

export interface IssueRequest {
  title: string;
  parent?: IssueId;
  blockedBy?: IssueId[];
  constraints?: IssueConstraints;
  description?: string;
  project?: string;
  agent?: string;
  priority?: Priority;
  deliver?: Deliverable;
  autoSubmitPr?: boolean;
  /** What it must do to be accepted, each checked by whoever works it before handing back. */
  criteria?: string[];
  /** The client's key for this request: the same key again within a while returns the first one's result and does it once (a retry after a lost reply). */
  requestKey?: string;
}

/** What an issue delivers: a change, a change kept on its branch for the owner to take in, or an answer (on the issue). */
export const DeliverableValues = ["change", "branch", "answer"] as const;
export type Deliverable = (typeof DeliverableValues)[number];

/** What a completed issue delivered: its branch merged into the project's main branch, into its parent issue's branch, by a pull request, its branch kept unmerged, or nothing (no change, or an answer). */
export const DeliveryValues = ["merged", "merged_into_parent", "pull_request", "kept", "none"] as const;
export type Delivery = (typeof DeliveryValues)[number];

/** Why an issue is not done: the owner closed it, or its workplace was lost. */
export const IssueCanceledValues = ["dismissed", "lost"] as const;
export type IssueCanceled = (typeof IssueCanceledValues)[number];

export interface CommentRequest {
  text: string;
  sendKey?: string;
}

/** A verdict on what was handed back: passed, or not, with the findings (or words) it is mended by. */
export interface IssueReviewRequest {
  pass: boolean;
  findings?: string[];
  text?: string;
}

/** Which issues issue.list gives: the open ones by default, the newest first. */
export interface IssueFilter {
  /** Only those in this status (closed ones included when it is done or canceled). */
  status?: IssueStatus;
  /** Words that the title or description all contain. */
  text?: string;
  project?: string;
  /** At most this many; none is all. */
  limit?: number;
  closed?: boolean;
  /** Only those waiting on the owner, the longest waiting first. */
  wantsOwner?: boolean;
}

/** One task of an issue split into several people's work: an issue under the graph the issue becomes. */
export interface IssueChildDraft {
  id: string;
  title?: string;
  brief: string;
  needs?: string[];
  /** A profile's id or name; empty is the farm's choice. */
  agent?: string;
  check?: string;
  scope?: string[];
  /** The task that checks the others' work against the whole. */
  acceptance?: boolean;
}

export interface IssueSplitRequest {
  title?: string;
  tasks: IssueChildDraft[];
}

export interface IssueStatusRequest {
  status: IssueStatus;
  /** Moving back to todo: another round with these words (findings, while it waits for acceptance), or, while it is stuck, none for the server's own. */
  text?: string;
  /** Moving to todo: the profile that takes it on. */
  agent?: string;
  /** Fields the owner changed and has not saved: saved first, so the act sees them. */
  edit?: IssueUpdate;
  /** The client's key for this request: the same key again within a while returns the first one's result and does it once (a retry after a lost reply). */
  requestKey?: string;
}

export interface FactSessionReported {
  type: "sessionReported";
  at: number;
  id: SessionId;
  run?: string;
  outcome: Outcome;
  /** A successful turn can rest for external feedback without handing off to the owner. */
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
