// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { Attachment } from "../attachment/shapes.gen";
import type { IssueId, Outcome, SessionId, Spent } from "../common/shapes.gen";
import type { Conflict, ReviewRevision } from "../repo/shapes.gen";
import type { IssueAnswer, PhaseRestingOnly, Session, SessionEvent } from "../session/shapes.gen";

/**
 * Lightweight typed owner/actor reference on issues (`user` or `agent`).
 */
export type ActorRef = { "kind": "user", id: string, } | { "kind": "agent", id: string, };

export const LandingValues = ["merged", "merged_into_parent", "pull_request", "submitted", "kept", "none"] as const;
export type Landing = (typeof LandingValues)[number];

export const IssueCanceledValues = ["dismissed", "lost"] as const;
export type IssueCanceled = (typeof IssueCanceledValues)[number];

export const PriorityValues = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PriorityValues)[number];

export const IssueStatusValues = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueStatus = (typeof IssueStatusValues)[number];

export const IssueLaneValues = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type IssueLane = (typeof IssueLaneValues)[number];

export const IssueCardKindValues = ["todo", "issue", "family", "orchestrator"] as const;
export type IssueCardKind = (typeof IssueCardKindValues)[number];

export const IssuePromptKindValues = ["asking", "review_after_failed_check", "reviewed", "handed_back", "stuck_conflict", "stuck_failed", "stuck_interrupted", "stuck_quiet", "stuck_unknown", "canceled_reopenable"] as const;
export type IssuePromptKind = (typeof IssuePromptKindValues)[number];

export type BoardLaneCounts = { backlog: number, todo: number, inProgress: number, inReview: number, done: number, canceled: number, };

export type BoardIssueSummary = { lane: IssueLane, cardKind: IssueCardKind, familyDone: number, familyTotal: number, needsWorktreeCheck: boolean, prompt?: IssuePromptKind, };

export type BoardSummary = { laneCounts: BoardLaneCounts, runningSlots: number, maxRunning: number, byIssue: { [key in string]: BoardIssueSummary }, };

export const PullRequestStateValues = ["open", "merged", "closed"] as const;
export type PullRequestState = (typeof PullRequestStateValues)[number];

export type PullRequest = { url: string, number: number, state: PullRequestState, };

export type Finding = { id: string, text: string, at: number, resolved: boolean, };

export type IssueRefining = { session: SessionId, name: string, };

export type Question = { question: string, options: Array<string>, };

export const CheckResultValues = ["met", "unmet", "unsure"] as const;
export type CheckResult = (typeof CheckResultValues)[number];

export type CriterionCheck = {
/**
 * 0-based index into `Issue.criteria`.
 */
criterion: number, result: CheckResult, proof: string, };

export const IssueStageKindValues = ["draft", "queued", "working", "asking", "reviewing", "stuck", "done", "canceled"] as const;
export type IssueStageKind = (typeof IssueStageKindValues)[number];

export const StuckReasonValues = ["failed", "conflict", "interrupted", "quiet"] as const;
export type StuckReason = (typeof StuckReasonValues)[number];

export const IssueActValues = ["start", "answer", "reject", "complete", "acknowledge", "resolve", "resume", "cure", "tell", "stop", "close", "reopen"] as const;
export type IssueAct = (typeof IssueActValues)[number];

export const ActWordsValues = ["none", "optional", "required"] as const;
export type ActWords = (typeof ActWordsValues)[number];

/**
 * `move` dispatches `issue.status.update`, `say` dispatches `issue.comment.create`, `stop` dispatches `session.stop`.
 */
export type IssueAction = { "does": "move", act: IssueAct, status: IssueStatus, words: ActWords, } | { "does": "say", act: IssueAct, } | { "does": "stop", act: IssueAct, };

export type IssueStage = { state: IssueStageKind, since?: number, stuck?: StuckReason,
/**
 * Primary action highlighted for the user, if any.
 */
lead?: IssueAct, acts: Array<IssueAction>, };

export const MilestoneKindValues = ["opened", "refined", "started", "reported", "asked", "failed", "stopped", "rejected", "accepted", "closed"] as const;
export type MilestoneKind = (typeof MilestoneKindValues)[number];

export type Milestone = { at: number, kind: MilestoneKind,
/**
 * Session name; absent for user or system milestones.
 */
who?: string, text: string,
/**
 * Plain-text summary from the run that produced this milestone, if any.
 */
said?: string,
/**
 * Run id that produced this milestone, if any.
 */
run?: string, };

export type IssueTimeline = { milestones: Array<Milestone>, spent?: Spent, };

export const DeliverableValues = ["change", "branch", "answer", "pull_request"] as const;
export type Deliverable = (typeof DeliverableValues)[number];

export type Execution = { "kind": "worker", session: SessionId, startedAt: number, } | { "kind": "orchestrator", session: string, startedAt: number, };

/**
 * Retained across execution contexts and ended only by reassignment or unassignment.
 */
export type Assignment = { id: string, issue: IssueId, agent: string, assignedAt: number, endedAt?: number, executions: Array<Execution>, };

export const MandateStrengthValues = ["explicit", "inferred"] as const;
export type MandateStrength = (typeof MandateStrengthValues)[number];

export type CodeReview = { at: number, revision: ReviewRevision, };

export const ProjectCheckStatusValues = ["passed", "failed", "not_configured"] as const;
export type ProjectCheckStatus = (typeof ProjectCheckStatusValues)[number];

export type ProjectCheckReceipt = { targetBranch: string, targetCommit: string, sourceTree: string, candidateCommit: string, candidateTree: string, status: ProjectCheckStatus, command?: string, output?: string, };

export type DeliveryEvidence = { reviews: Array<CodeReview>, check?: ProjectCheckReceipt, mergedCommit?: string, };

export type IssueMandate = { originTriggerId?: string, strength: MandateStrength, maxBotReviewRounds: number, autoSubmitPr: boolean, };

export const IssueReportMemoryScopeValues = ["repo", "all"] as const;
export type IssueReportMemoryScope = (typeof IssueReportMemoryScopeValues)[number];

export type IssueReportMemory = { text: string, scope: IssueReportMemoryScope, };

export type IssueReport = { summary: string, questions: Array<Question>, checks: Array<CriterionCheck>, remember: Array<IssueReportMemory>, prSubmit: boolean, answer?: IssueAnswer, };

export type IssueConstraints = { check?: string, scope: Array<string>, acceptance: boolean, frozen: Array<string>, };

export type IssueLastRun = { startedAt: number, endedAt?: number, outcome?: Outcome, };

export type Issue = { constraints?: IssueConstraints, id: IssueId, number: number, title: string, description: string, mandate: IssueMandate, conflict?: Conflict, repo?: string,
/**
 * Target execution host id when pinned to a specific machine; omitted lets the control plane route.
 */
machineId?: string, assignments: Array<Assignment>, priority: Priority, rank?: number, createdAt: number, queuedAt?: number, closedAt?: number, delivered?: Landing, canceled?: IssueCanceled, parent?: IssueId, blockedBy: Array<IssueId>, cron?: string, status: IssueStatus, moves: Array<IssueStatus>, pullRequest?: PullRequest, deliver: Deliverable, reviewedAt?: number, deliveryEvidence?: DeliveryEvidence, findings: Array<Finding>, questions: Array<Question>, criteria: Array<string>, checks: Array<CriterionCheck>, refining?: IssueRefining,
/**
 * Tracks runs executed without a worker session (e.g. in-process orchestrator); active while `endedAt` is absent.
 */
lastRun?: IssueLastRun, answer?: IssueAnswer, stage: IssueStage, attachments?: Array<Attachment>, tags?: Array<string>, startAt?: number, dueAt?: number, owner?: ActorRef, };

/**
 * Includes the Core fold `seq` that applied the mutation so clients can await state convergence.
 */
export type AppliedIssue = { constraints?: IssueConstraints, id: IssueId, number: number, title: string, description: string, mandate: IssueMandate, conflict?: Conflict, repo?: string,
/**
 * Target execution host id when pinned to a specific machine; omitted lets the control plane route.
 */
machineId?: string, assignments: Array<Assignment>, priority: Priority, rank?: number, createdAt: number, queuedAt?: number, closedAt?: number, delivered?: Landing, canceled?: IssueCanceled, parent?: IssueId, blockedBy: Array<IssueId>, cron?: string, status: IssueStatus, moves: Array<IssueStatus>, pullRequest?: PullRequest, deliver: Deliverable, reviewedAt?: number, deliveryEvidence?: DeliveryEvidence, findings: Array<Finding>, questions: Array<Question>, criteria: Array<string>, checks: Array<CriterionCheck>, refining?: IssueRefining, lastRun?: IssueLastRun, answer?: IssueAnswer, stage: IssueStage, attachments?: Array<Attachment>, tags?: Array<string>, startAt?: number, dueAt?: number, owner?: ActorRef, seq: number, };

export type IssueUpdate = { title?: string, description?: string, repo?: string, agent?: string, machineId?: string, priority?: Priority, criteria?: Array<string>, deliver?: Deliverable,
/**
 * Board placement before this issue id; "" places it last. Valid only before dispatch.
 */
before?: string, attachments?: Array<string>,
/**
 * Parent issue id or number; "" clears the parent.
 */
parent?: string,
/**
 * Blocker issue ids or numbers; `[]` clears all blockers.
 */
blockedBy?: Array<string>, tags?: Array<string>,
/**
 * Start date timestamp (ms); 0 or negative clears it.
 */
startAt?: number,
/**
 * Target due timestamp (ms); 0 or negative clears it.
 */
dueAt?: number,
/**
 * Final owner (`user` or `agent`); empty `id` clears it.
 */
owner?: ActorRef, };

export type IssueHistory = { issue: Issue, sessions: Array<Session>, missingSessions: Array<SessionId>, };

export type IssueRefineRequest = { text?: string,
/**
 * Unsaved field edits applied atomically before refining starts.
 */
edit?: IssueUpdate, };

export type IssueRequest = { constraints?: IssueConstraints, title: string, parent?: IssueId, blockedBy?: Array<IssueId>, description?: string, repo?: string, agent?: string, machineId?: string, priority?: Priority, deliver?: Deliverable, autoSubmitPr?: boolean, criteria?: Array<string>, attachments?: Array<string>, tags?: Array<string>, startAt?: number, dueAt?: number, owner?: ActorRef,
/**
 * Idempotency key deduplicating retries after a lost response.
 */
requestKey?: string, };

export type CommentRequest = { text: string, sendKey?: string, };

export type IssueReviewRequest = { revision?: ReviewRevision, pass: boolean, findings?: Array<string>, text?: string, };

export type IssueFilter = {
/**
 * Includes closed issues when set to `done` or `canceled`.
 */
status?: IssueStatus, text?: string, repo?: string, limit?: number, closed?: boolean,
/**
 * Filters to issues waiting on the user, ordered longest-waiting first.
 */
wantsUser?: boolean, };

export type IssueChildDraft = { id: string, title?: string, brief: string, needs?: Array<string>,
/**
 * Profile id or name; "" lets the server assign one.
 */
agent?: string, check?: string, scope?: Array<string>, acceptance?: boolean, };

export type IssueSplitRequest = { title?: string, tasks: Array<IssueChildDraft>, };

export type IssueStatusRequest = { revision?: ReviewRevision, status: IssueStatus,
/**
 * Follow-up instructions or review findings when moving back to `todo`.
 */
text?: string, agent?: string,
/**
 * Unsaved field edits applied atomically before the status transition.
 */
edit?: IssueUpdate,
/**
 * Idempotency key deduplicating retries after a lost response.
 */
requestKey?: string, };

export type FactSessionReported = { "type": "sessionReported", at: number, id: SessionId, run?: string, outcome: Outcome,
/**
 * Set when a turn rests waiting on external feedback without handing off to the user.
 */
phase?: PhaseRestingOnly, summary: string, runs: number, spent?: Spent, questions: Array<Question>, checks: Array<CriterionCheck>, answer?: IssueAnswer, };

export type FactIssueChanged = { "type": "issueChanged", at: number, issue: Issue, };

export type FactIssueRemoved = { "type": "issueRemoved", at: number, id: IssueId, };

export type IssueWatch = { "kind": "history", session: SessionId, events: Array<SessionEvent>, } | { "kind": "state", issue: Issue, sessions: Array<Session>, sessionIds: Array<SessionId>, settled: boolean, omittedSessions: number, } | { "kind": "event", session: SessionId, event: SessionEvent, } | { "kind": "gap", session: SessionId, before?: number, } | { "kind": "missing", issue: IssueId, };

export type IssueConversationGetInput = { id: string, };

export type IssueCommentCreateInput = { id: string, text: string, sendKey?: string, };

export type IssueDiffGetInput = { id: string, sinceTree?: string, };

export type IssueReviewInput = { revision?: ReviewRevision, id: string, pass: boolean, findings?: Array<string>, text?: string, };

export type IssueSplitInput = { id: string, title?: string, tasks: Array<IssueChildDraft>, };

export type IssueGetInput = { id: string, };

export type IssueRunListInput = { id: string, };

export type IssueTimelineGetInput = { id: string, };

export type IssueUpdateInput = { id: string, title?: string, description?: string, repo?: string, agent?: string, machineId?: string, priority?: Priority, criteria?: Array<string>, deliver?: Deliverable, before?: string, attachments?: Array<string>,
/**
 * Parent issue id or number; "" clears the parent.
 */
parent?: string,
/**
 * Blocker issue ids or numbers; `[]` clears all blockers.
 */
blockedBy?: Array<string>, tags?: Array<string>,
/**
 * Start date timestamp (ms); 0 or negative clears it.
 */
startAt?: number,
/**
 * Target due timestamp (ms); 0 or negative clears it.
 */
dueAt?: number,
/**
 * Final owner (`user` or `agent`); empty `id` clears it.
 */
owner?: ActorRef, };

export type IssueDeleteInput = { id: string, };

export type IssueStatusUpdateInput = { revision?: ReviewRevision, id: string, status: IssueStatus, text?: string, agent?: string, edit?: IssueUpdate, requestKey?: string, };

export type IssueRefineInput = { id: string, text?: string, edit?: IssueUpdate, };
