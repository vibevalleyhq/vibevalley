// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { AgentRole, IssueId, Outcome, Retry, SessionId, Spent } from "../common/shapes.gen";

export const SessionActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other", "thinking", "speaking_text", "none"] as const;
export type SessionAction = (typeof SessionActionValues)[number];

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

export type Session = { id: SessionId, role: AgentRole, name: string, agent: string, runtime: string, brief: string, repo?: string, branch?: string, worktree?: string, hiredAt: number, runs: number, lastRun?: LastRun, spent?: Spent, channel?: string, issue?: IssueId, refining: boolean, subagents?: SessionSubagents, toolConnections?: Array<ToolConnection>,
/**
 * The machine it works on; none for an agent hosted in the server's process.
 */
machine?: string, phase: Phase, };

/**
 * reduce never sees these: the words are the frame's (projection/frame.ts).
 */
export type SessionView = { id: SessionId, role: AgentRole, name: string, agent: string, runtime: string, brief: string, repo?: string, branch?: string, worktree?: string, hiredAt: number, runs: number, lastRun?: LastRun, spent?: Spent, channel?: string, issue?: IssueId, refining: boolean, subagents?: SessionSubagents, toolConnections?: Array<ToolConnection>, machine?: string, phase: PhaseView, phaseText: string, };

export const SessionEventTypeValues = ["run/start", "user/message", "memory/recalled", "assistant/thinking", "assistant/message", "tool/call", "tool/result", "llm/retry", "llm/usage", "run/error", "run/end"] as const;
export type SessionEventType = (typeof SessionEventTypeValues)[number];

export const ToolActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other"] as const;
export type ToolAction = (typeof ToolActionValues)[number];

export type EventTokens = { input: number, cacheRead: number, output: number, };

export type SessionEvent = { seq: number,
/**
 * Increases when this step's streaming text or input changes; independent of transport delivery order.
 */
revision: number, time: number, type: SessionEventType, run?: string, call?: number, under?: number, threadId?: string, text: string, action?: ToolAction, actionText?: string, tool?: string, input?: string, output?: string, ok?: boolean, tokens?: EventTokens, connection?: ToolConnection, };

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
online: boolean, joinedAt: number, };

export type FactMachineChanged = { "type": "machineChanged", at: number, machine: Machine, };

/**
 * `PhaseResting` where nothing else is taken: its `_tag` written.
 */
export type PhaseRestingOnly = PhaseResting;

export type SessionStopInput = { id: string, };

export type SessionListInput = { agent?: string, };

export type SessionGetInput = { id: string, };

export type SessionEventListInput = { id: string, run?: string, };
