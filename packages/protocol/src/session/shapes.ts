import type { AgentRole } from "../agent/shapes";
import type { IssueId, Outcome, Retry, SessionId, Spent } from "../common/shapes";

export const SessionActionValues = [
  "run_command",
  "read_file",
  "edit_file",
  "search",
  "web",
  "mcp",
  "wait",
  "other",
  "thinking",
  "speaking_text",
  "none",
] as const;
export type SessionAction = (typeof SessionActionValues)[number];

export interface Doing {
  action: SessionAction;
  label: string;
}

/** A Doing as the frame tells it: its action in the owner's words. */
export interface DoingView extends Doing {
  actionText: string;
}

/** Told apart by `_tag`. */
export type Phase = PhaseWorking | PhaseDone | PhaseFailed | PhaseResting | PhaseClosed;

export interface LastRun {
  outcome: Outcome;
  summary: string;
  at: number;
  spent?: Spent;
  /** The conclusion it handed back in the block an answer issue asks for, when one could be read. */
  answer?: IssueAnswer;
}

export const ToolConnectionStatusValues = ["unknown", "starting", "ready", "failed", "cancelled"] as const;

export interface ToolConnection {
  server: string;
  status: (typeof ToolConnectionStatusValues)[number];
  reason?: string;
}

export interface Session {
  id: SessionId;
  role: AgentRole;
  name: string;
  agent: string;
  runtime: string;
  brief: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  hiredAt: number;
  runs: number;
  phase: Phase;
  lastRun?: LastRun;
  spent?: Spent;
  channel?: string;
  issue?: IssueId;
  refining: boolean;
  toolConnections?: ToolConnection[];
}

/** reduce never sees these: the words are the frame's (projection/frame.ts). */
export interface SessionView extends Omit<Session, "phase"> {
  phase: PhaseView;
  phaseText: string;
}

export type PhaseView = Exclude<Phase, PhaseWorking> | PhaseWorkingView;

export interface PhaseWorkingView extends Omit<PhaseWorking, "doing"> {
  doing: DoingView;
}

export const SessionEventTypeValues = [
  "run/start",
  "user/message",
  "memory/recalled",
  "assistant/thinking",
  "assistant/message",
  "tool/call",
  "tool/result",
  "llm/retry",
  "llm/usage",
  "run/error",
  "run/end",
] as const;
export type SessionEventType = (typeof SessionEventTypeValues)[number];

export const ToolActionValues = ["run_command", "read_file", "edit_file", "search", "web", "mcp", "wait", "other"] as const;
export type ToolAction = (typeof ToolActionValues)[number];

export interface SessionEvent {
  seq: number;
  /** Increases when this step's streaming text or input changes; independent of transport delivery order. */
  revision: number;
  time: number;
  type: SessionEventType;
  run?: string;
  call?: number;
  under?: number;
  text: string;
  action?: ToolAction;
  actionText?: string;
  tool?: string;
  input?: string;
  output?: string;
  ok?: boolean;
  tokens?: EventTokens;
  connection?: ToolConnection;
}

export interface EventTokens {
  input: number;
  cacheRead: number;
  output: number;
}

/** What an answer issue concludes, as its helper hands it back. */
export interface IssueAnswer {
  conclusion: string;
  evidence: string[];
  unsure: string[];
  next: string[];
}

/** How a session left: its work merged into the main branch, its issue completed otherwise, sent home, or its workplace lost. */
export const SessionCloseValues = ["merged", "completed", "dismissed", "lost"] as const;
export type SessionClose = (typeof SessionCloseValues)[number];

export const RunTriggerKindValues = ["issue", "comment", "cron", "refine", "runtime"] as const;
export type RunTriggerKind = (typeof RunTriggerKindValues)[number];

export interface RunTrigger {
  kind: RunTriggerKind;
  message?: string;
  /** Where the input was said and its reply belongs. */
  channel?: string;
  cron?: string;
  missed?: boolean;
}

export interface Run {
  id: string;
  session: SessionId;
  issue?: IssueId;
  triggeredBy: RunTrigger;
  heard: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: Outcome;
  summary: string;
  spent?: Spent;
}

export interface PhaseWorking {
  _tag: "working";
  since: number;
  doing: Doing;
  quietSince?: number;
  retry?: Retry;
}

export interface PhaseDone {
  _tag: "done";
}

export interface PhaseFailed {
  _tag: "failed";
}

export interface PhaseResting {
  _tag: "resting";
}

export interface PhaseClosed {
  _tag: "closed";
  at: number;
  closed: SessionClose;
}

export interface FactSessionPhaseChanged {
  type: "sessionPhaseChanged";
  at: number;
  id: SessionId;
  phase: Phase;
  channel?: string;
  spent?: Spent;
  brief?: string;
}

export interface FactSessionChanged {
  type: "sessionChanged";
  at: number;
  session: Session;
}

export interface FactSessionLeft {
  type: "sessionLeft";
  at: number;
  id: SessionId;
  closed?: SessionClose;
  merged?: number;
}

export interface FactSessionToolChanged {
  type: "sessionToolChanged";
  at: number;
  id: SessionId;
  connection: ToolConnection;
}

export interface FactSessionToolsReset {
  type: "sessionToolsReset";
  at: number;
  id: SessionId;
}
