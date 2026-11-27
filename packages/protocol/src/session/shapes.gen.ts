// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { AgentRole, ArtifactId, IssueId, Outcome, Retry, SessionId, Spent } from "../common/shapes.gen";
import type { MachinePlatform, MachineStatus } from "../machine/shapes.gen";

export const SessionActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other", "thinking", "speaking_text", "none"] as const;
export type SessionAction = (typeof SessionActionValues)[number];

export const SessionControllerValues = ["user", "issueBoard", "channel", "orchestrator"] as const;
export type SessionController = (typeof SessionControllerValues)[number];

export type ExecutionPolicy = { "kind": "directCwd", repo?: string, permissionMode: SessionPermissionMode, } | { "kind": "managedWorktree", repo: string, branch?: string, } | { "kind": "sandboxDir" };

export type ContextRef = { "kind": "issue", id: IssueId, refining?: boolean, } | { "kind": "channel", id: string, } | { "kind": "artifact", id: ArtifactId, };

export type Doing = { action: SessionAction, label: string, };

/**
 * A Doing as the frame tells it: its action in the user's words.
 */
export type DoingView = { action: SessionAction, label: string, actionText: string, };

export type PhaseWorking = { "_tag": "working", since: number, quietSince?: number, retry?: Retry, doing: Doing, };

export type PhaseWorkingView = { "_tag": "working", since: number, quietSince?: number, retry?: Retry, doing: DoingView, };

export type PhaseDone = { "_tag": "done", };

export type PhaseFailed = { "_tag": "failed", };

export type PhaseResting = { "_tag": "resting", };

export const SessionCloseValues = ["merged", "completed", "dismissed", "lost"] as const;
export type SessionClose = (typeof SessionCloseValues)[number];

export type PhaseClosed = { "_tag": "closed", at: number, closed: SessionClose, };

/**
 * Told apart by `_tag`.
 */
export type Phase = PhaseWorking | PhaseDone | PhaseFailed | PhaseResting | PhaseClosed;

export type PhaseView = PhaseWorkingView | PhaseDone | PhaseFailed | PhaseResting | PhaseClosed;

/**
 * What an answer issue concludes, as its helper hands it back.
 */
export type IssueAnswer = { conclusion: string, evidence: Array<string>, unsure: Array<string>, next: Array<string>, };

export type LastRun = { needsReconciliation?: boolean, outcome: Outcome, summary: string, at: number, spent?: Spent,
/**
 * The conclusion it handed back in the block an answer issue asks for, when one could be read.
 */
answer?: IssueAnswer, };

export const ToolConnectionStatusValues = ["unknown", "starting", "ready", "failed", "cancelled"] as const;
export type ToolConnectionStatus = (typeof ToolConnectionStatusValues)[number];

export type ToolConnection = { server: string, status: ToolConnectionStatus, reason?: string, };

export const SubagentStatusValues = ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"] as const;
export type SubagentStatus = (typeof SubagentStatusValues)[number];

export const SubagentStepStatusValues = ["pending", "inProgress", "completed"] as const;
export type SubagentStepStatus = (typeof SubagentStepStatusValues)[number];

export type SubagentStep = { step: string, status: SubagentStepStatus, };

export type SubagentThread = { threadId: string, agentName?: string, parentThreadId?: string, turnId?: string, steps?: Array<SubagentStep>, task?: string, status?: SubagentStatus, lastActivity?: string, lastAction?: ToolAction, updatedAt: number, };

export type SubagentWait = { threadId: string, callId: string, targets: Array<string>, };

export type SessionSubagents = { run: string, rootThreadId: string, disconnectedAt?: number, threads: Array<SubagentThread>, waits: Array<SubagentWait>, };

export type FactSessionSubagentsChanged = { "type": "sessionSubagentsChanged", at: number, id: SessionId, subagents?: SessionSubagents, };

export type Session = { id: SessionId, controller: SessionController, role?: AgentRole, name: string, profile?: string, runtime: string, brief: string, cwd?: string, policy: ExecutionPolicy, bindings: Array<ContextRef>, hiredAt: number, runs: number, lastRun?: LastRun, spent?: Spent, subagents?: SessionSubagents, toolConnections?: Array<ToolConnection>, telemetry?: SessionTelemetry,
/**
 * The machine it works on; none for an agent hosted in the server's process.
 */
machine?: string, phase: Phase, };

/**
 * reduce never sees these: the words are the frame's (projection/frame.ts).
 */
export type SessionView = { id: SessionId, controller: SessionController, role?: AgentRole, name: string, profile?: string, runtime: string, brief: string, cwd?: string, policy: ExecutionPolicy, bindings: Array<ContextRef>, hiredAt: number, runs: number, lastRun?: LastRun, spent?: Spent, subagents?: SessionSubagents, toolConnections?: Array<ToolConnection>, telemetry?: SessionTelemetry, machine?: string, phase: PhaseView, phaseText: string, };

export const SessionEventTypeValues = ["run/start", "user/message", "memory/recalled", "assistant/thinking", "assistant/message", "tool/call", "tool/result", "permission/request", "permission/resolved", "interaction/request", "interaction/resolved", "llm/retry", "llm/usage", "run/error", "run/end"] as const;
export type SessionEventType = (typeof SessionEventTypeValues)[number];

export const ToolActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other"] as const;
export type ToolAction = (typeof ToolActionValues)[number];

export type EventTokens = { input: number, cacheRead: number, output: number, cacheWrite?: number, reasoning?: number, contextUsed?: number, contextWindow?: number, };

/**
 * Aggregated token usage, context saturation, and retry/error counts for a session.
 */
export type SessionTelemetry = { inputTokens: number, cacheReadTokens: number, outputTokens: number, cacheWriteTokens?: number, reasoningTokens?: number, contextUsed?: number, contextWindow?: number, llmRetries: number, runErrors: number, };

export const SessionPermissionModeValues = ["ask", "acceptEdits", "bypass", "readOnly"] as const;
export type SessionPermissionMode = (typeof SessionPermissionModeValues)[number];

export const SessionPermissionDecisionValues = ["allowOnce", "allowAlways", "deny"] as const;
export type SessionPermissionDecision = (typeof SessionPermissionDecisionValues)[number];

export type SessionPermissionRequest = { requestId: string, tool: string, summary: string, input?: string, };

export type SessionInteractionOption = { id: string, label: string, description?: string, warning?: string, };

export type SessionInteractionRequest = { requestId: string, question: string, options: Array<SessionInteractionOption>, allowCustom: boolean, };

export type SessionInteractionResolution = { requestId: string, accepted: boolean, choice?: string, };

export type SessionEvent = { seq: number,
/**
 * Increases when this step's streaming text or input changes; independent of transport delivery order.
 */
revision: number, time: number, type: SessionEventType, run?: string, call?: number, under?: number, threadId?: string, text: string, action?: ToolAction, actionText?: string, tool?: string, input?: string, output?: string, ok?: boolean, tokens?: EventTokens, connection?: ToolConnection, permission?: SessionPermissionRequest, interaction?: SessionInteractionRequest, interactionResolution?: SessionInteractionResolution, };

export const RunTriggerKindValues = ["issue", "comment", "cron", "refine", "runtime"] as const;
export type RunTriggerKind = (typeof RunTriggerKindValues)[number];

export type RunTrigger = { kind: RunTriggerKind, message?: string,
/**
 * Where the input was said and its reply belongs.
 */
channel?: string, cron?: string, missed?: boolean, };

export type Run = {
/**
 * The external worker disconnected before acknowledging its changes.
 */
needsReconciliation?: boolean, id: string, session: SessionId, issue?: IssueId, subagents?: SessionSubagents, triggeredBy: RunTrigger, heard: Array<string>, startedAt: number, endedAt?: number, outcome?: Outcome, summary: string, spent?: Spent, };

export type FactSessionPhaseChanged = { "type": "sessionPhaseChanged", at: number, id: SessionId, phase: Phase, channel?: string, spent?: Spent, brief?: string, };

export type FactSessionChanged = { "type": "sessionChanged", at: number, session: Session, };

export type FactSessionLeft = { "type": "sessionLeft", at: number, id: SessionId, closed?: SessionClose, merged?: number, };

export type FactSessionToolChanged = { "type": "sessionToolChanged", at: number, id: SessionId, connection: ToolConnection, };

export type FactSessionToolsReset = { "type": "sessionToolsReset", at: number, id: SessionId, };

/**
 * A computer the farm's helpers work on. Today the one this server runs on; others join from the command line.
 */
export type Machine = { id: string, name: string,
/**
 * The server's own machine: its helpers run in the server's process.
 */
here: boolean,
/**
 * Reachable now: the server can hire helpers on it.
 */
online: boolean, joinedAt: number, platform?: MachinePlatform, status?: MachineStatus, ephemeral?: boolean, runtimes?: Array<string>, };

export type FactMachineChanged = { "type": "machineChanged", at: number, machine: Machine, };

export type FactMachineRemoved = { "type": "machineRemoved", at: number, id: string, };

/**
 * `PhaseResting` where nothing else is taken: its `_tag` written.
 */
export type PhaseRestingOnly = PhaseResting;

export type SessionStopInput = { id: string, };

export type SessionListInput = { profile?: string, controller?: SessionController, };

export type SessionGetInput = { id: string, };

export type SessionEventListInput = { id: string, run?: string, beforeSeq?: number, afterSeq?: number, limit?: number, };

export type TrajectoryRunView = { run?: string, asked?: SessionEvent, steps: Array<SessionEvent>, };

export const TrajectoryWaterfallLaneValues = ["asked", "model", "tool"] as const;
export type TrajectoryWaterfallLane = (typeof TrajectoryWaterfallLaneValues)[number];

export type TrajectoryLaneSpan = { lane: TrajectoryWaterfallLane, start: number, end: number, seq: number, };

export type TrajectoryWaterfall = { runs: Array<[number, number]>, spans: Array<TrajectoryLaneSpan>, };

export type TrajectorySummary = { runs: number, steps: number, modelMs: number, toolMs: number, input: number, cacheRead: number, output: number, };

export type TrajectoryStepDuration = { seq: number, durationMs: number, };

export type TrajectoryStepMeta = { seq: number, durationMs: number, readableInput?: string, collapsedSummary?: string, };

export type SessionTrajectoryProjection = { shown: Array<SessionEvent>, runs: Array<TrajectoryRunView>, waterfall: TrajectoryWaterfall, summary: TrajectorySummary, stepDurations: Array<TrajectoryStepDuration>, stepMeta: Array<TrajectoryStepMeta>, telemetry: SessionTelemetry, };

export type ActivityStep = { step: SessionEvent, durationMs?: number, };

export type ActivityEditedFile = { path: string, line?: number, canDiff: boolean, };

export type ActivityCommandPreview = { seq: number, command: string, running: boolean, failed: boolean, };

export const TodoStepStatusValues = ["pending", "in_progress", "done", "skipped", "failed"] as const;
export type TodoStepStatus = (typeof TodoStepStatusValues)[number];

export type TodoStep = { title: string, status: TodoStepStatus, };

export type TodoChecklist = { seq: number, steps: Array<TodoStep>, doneCount: number, inProgressCount: number, failedCount: number, totalCount: number, activeStep?: TodoStep, };

export type ActivitySummary = { totalSteps: number, thinkingCount: number, readCount: number, searchCount: number, editCount: number, commandCount: number, otherToolCount: number, totalTools: number, runningCount: number, failedCount: number, startedAt: number, durationMs: number, editedFiles: Array<ActivityEditedFile>, latestCommand?: ActivityCommandPreview, };

export type ChatFeedItem = { "kind": "step", key: string, step: SessionEvent, durationMs?: number, trailing: boolean, } | { "kind": "activity", key: string, steps: Array<ActivityStep>, summary: ActivitySummary, trailing: boolean, };

export type ToolTarget = { path: string, line?: number, canDiff: boolean, };

export type ToolDetails = { headline: string, formattedInput: string, outputLines: number, };

export type ChatToolStepProjection = { seq: number, target?: ToolTarget, details: ToolDetails, todo?: TodoChecklist, };

export type ChatTelemetry = { cachedRead: number, uncachedInput: number, totalInput: number, output: number, reasoning: number, contextUsed: number, contextWindow: number, contextPct: number, cacheHitPct: number, turns: number, toolCount: number, hasData: boolean, };

export const BoardTextTokenKindValues = ["text", "mention", "seq", "tag"] as const;
export type BoardTextTokenKind = (typeof BoardTextTokenKindValues)[number];

export type BoardTextToken = { kind: BoardTextTokenKind, value: string, };

export type ChatSessionProjection = { visibleSteps: Array<SessionEvent>, feedItems: Array<ChatFeedItem>, latestTodos?: TodoChecklist, telemetry: ChatTelemetry, toolEntries: Array<ChatToolStepProjection>, };

export type SessionEventPage = { events: Array<SessionEvent>, hasMore: boolean, oldestSeq?: number, newestSeq?: number, trajectory?: SessionTrajectoryProjection, };

export type SessionBindingInput = { id: string, binding: ContextRef, };

export type SessionContextFile = { path: string, startLine?: number, endLine?: number, };

export type SessionOpenWorkspaceInput = { sessionId?: string, runtime: string, cwd: string, repo?: string, model?: string, effort?: string, permissionMode?: SessionPermissionMode, title?: string, };

export type SessionCloseWorkspaceInput = { id: string, };

export type SessionWorkspace = { id: SessionId, session: Session, title?: string, model?: string, effort?: string, permissionMode: SessionPermissionMode, };

export type SessionSendInput = { id: string, text: string, attachments?: Array<string>, contextFiles?: Array<SessionContextFile>, };

export type SessionRespondPermissionInput = { id: string, requestId: string, decision: SessionPermissionDecision, message?: string, };

export type SessionRespondInteractionInput = { id: string, requestId: string, optionId?: string, text?: string, cancelled?: boolean, };

export type SessionSetConfigInput = { id: string, model?: string, effort?: string, permissionMode?: SessionPermissionMode, };

export const SessionSwarmRoleValues = ["coordinator", "worker"] as const;
export type SessionSwarmRole = (typeof SessionSwarmRoleValues)[number];

export const SessionSwarmMemberStateValues = ["working", "waiting", "stopped", "killed"] as const;
export type SessionSwarmMemberState = (typeof SessionSwarmMemberStateValues)[number];

export type SessionSwarmMember = { name: string, conversationId: string, role: SessionSwarmRole, state: SessionSwarmMemberState, wakeMode?: string, waitSince?: number, model?: string, workspaceMode?: string, task?: string, };

export type SessionSwarmThread = { id: string, title: string, goal?: string, members: Array<string>, };

export type SessionSwarmOverview = { goalTitle?: string, goalLine?: string, threads: Array<SessionSwarmThread>, tasks: { [key in string]: string }, };

export type SessionSwarmMessage = { seq: number, agent: string, text: string, time: string, kind?: string, };

export type SessionSwarmState = { swarmId: string, title?: string, workingCount: number, activeCount: number, members: Array<SessionSwarmMember>, overview?: SessionSwarmOverview, messages: Array<SessionSwarmMessage>, totalMessages: number, };

export type SessionChildToolCall = { name: string, args?: string, };

export type SessionChildStep = { stepIndex: number, source: string, kind: string, status?: string, createdAt?: string, model?: string, thinking?: string, content?: string, error?: string, toolCalls: Array<SessionChildToolCall>, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number, };

export type SessionChildTranscriptInput = { id: string, conversationId: string, limit?: number, };

export type SessionChildTranscript = { conversationId: string, steps: Array<SessionChildStep>, };

/**
 * Request to manually compact conversation context for a session.
 */
export type SessionCompactInput = { id: string, };

/**
 * Result of manually compacting conversation context for a session.
 */
export type SessionCompactResult = { id: string, compacted: boolean, summary?: string, reason?: string, };

/**
 * Request to execute a durable CodeMode JavaScript task within a session's context.
 */
export type SessionRunCodeInput = { id: string, script: string, seed?: number, timeoutMs?: number, maxSteps?: number, };

/**
 * Result of a durable CodeMode script execution.
 */
export type SessionRunCodeResult = { id: string, taskId: string, outputJson: string, executedSteps: number, replayedCalls: number, replayedSleeps: number, virtualNowMs: number, };

export type SessionWatchPayload = { id: string, afterSeq?: number, };

export type SessionWatchEvent = { "kind": "state", session: Session, title?: string, model?: string, effort?: string, permissionMode: SessionPermissionMode, pendingPermissions: Array<SessionPermissionRequest>, pendingInteractions: Array<SessionInteractionRequest>, tokens?: EventTokens, swarm?: SessionSwarmState, } | { "kind": "history", session: SessionId, events: Array<SessionEvent>, projection?: ChatSessionProjection, } | { "kind": "event", session: SessionId, event: SessionEvent, projection?: ChatSessionProjection, } | { "kind": "missing", session: SessionId, };
