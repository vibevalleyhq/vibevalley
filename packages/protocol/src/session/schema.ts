import { z } from "zod";

import { AgentRoleValues } from "../agent/shapes";
import type { Codec } from "../codec";
import { IssueId, Outcome, Retry, SessionId, Spent } from "../common/schema";
import * as T from "./shapes.gen";

const SessionAction = z.enum(T.SessionActionValues) satisfies Codec<T.SessionAction>;

export const doingFields = {
  action: SessionAction,
  label: z.string(),
};

const Doing = z.object(doingFields) satisfies Codec<T.Doing>;

const DoingView = z.object({ ...doingFields, actionText: z.string() }) satisfies Codec<T.DoingView>;

const workingFields = {
  since: z.number(),
  quietSince: z.exactOptional(z.number()),
  retry: z.exactOptional(Retry),
};

const PhaseWorking = z.object({ _tag: z.literal("working"), ...workingFields, doing: Doing }) satisfies Codec<T.PhaseWorking>;

const PhaseWorkingView = z.object({ _tag: z.literal("working"), ...workingFields, doing: DoingView }) satisfies Codec<T.PhaseWorkingView>;

const PhaseDone = z.object({ _tag: z.literal("done") }) satisfies Codec<T.PhaseDone>;

const PhaseFailed = z.object({ _tag: z.literal("failed") }) satisfies Codec<T.PhaseFailed>;

export const PhaseResting = z.object({ _tag: z.literal("resting") }) satisfies Codec<T.PhaseResting>;

const SessionClose = z.enum(T.SessionCloseValues) satisfies Codec<T.SessionClose>;

const PhaseClosed = z.object({ _tag: z.literal("closed"), at: z.number(), closed: SessionClose }) satisfies Codec<T.PhaseClosed>;

export const Phase = z.discriminatedUnion("_tag", [PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]) satisfies Codec<T.Phase>;

const PhaseView = z.discriminatedUnion("_tag", [PhaseWorkingView, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]) satisfies Codec<T.PhaseView>;

export const IssueAnswer = z.object({
  conclusion: z.string(),
  evidence: z.array(z.string()),
  unsure: z.array(z.string()),
  next: z.array(z.string()),
}) satisfies Codec<T.IssueAnswer>;

export const LastRun = z.object({
  needsReconciliation: z.exactOptional(z.boolean()),
  outcome: Outcome,
  summary: z.string(),
  at: z.number(),
  spent: z.exactOptional(Spent),
  answer: z.exactOptional(IssueAnswer),
}) satisfies Codec<T.LastRun>;

const ToolConnection = z.object({
  server: z.string(),
  status: z.enum(T.ToolConnectionStatusValues),
  reason: z.exactOptional(z.string()),
}) satisfies Codec<T.ToolConnection>;

const SubagentThread = z.object({
  threadId: z.string(),
  agentName: z.exactOptional(z.string()),
  parentThreadId: z.exactOptional(z.string()),
  turnId: z.exactOptional(z.string()),
  steps: z.exactOptional(z.array(z.object({ step: z.string(), status: z.enum(T.SubagentStepStatusValues) }))),
  task: z.exactOptional(z.string()),
  status: z.exactOptional(z.enum(T.SubagentStatusValues)),
  lastActivity: z.exactOptional(z.string()),
  lastAction: z.exactOptional(z.enum(T.ToolActionValues)),
  updatedAt: z.number(),
}) satisfies Codec<T.SubagentThread>;

const SessionSubagents = z.object({
  run: z.string(),
  rootThreadId: z.string(),
  disconnectedAt: z.exactOptional(z.number()),
  threads: z.array(SubagentThread),
  waits: z.array(z.object({ threadId: z.string(), callId: z.string(), targets: z.array(z.string()) })),
}) satisfies Codec<T.SessionSubagents>;

const sessionFields = {
  id: SessionId,
  role: z.enum(AgentRoleValues),
  name: z.string(),
  agent: z.string(),
  runtime: z.string(),
  brief: z.string(),
  repo: z.exactOptional(z.string()),
  branch: z.exactOptional(z.string()),
  worktree: z.exactOptional(z.string()),
  hiredAt: z.number(),
  runs: z.number(),
  lastRun: z.exactOptional(LastRun),
  spent: z.exactOptional(Spent),
  channel: z.exactOptional(z.string()),
  issue: z.exactOptional(IssueId),
  refining: z.boolean(),
  subagents: z.exactOptional(SessionSubagents),
  toolConnections: z.exactOptional(z.array(ToolConnection)),
  machine: z.exactOptional(z.string()),
};

export const Session = z.object({ ...sessionFields, phase: Phase }) satisfies Codec<T.Session>;

export const SessionView = z.object({
  ...sessionFields,
  phase: PhaseView,
  phaseText: z.string(),
}) satisfies Codec<T.SessionView>;

const SessionEventType = z.enum(T.SessionEventTypeValues) satisfies Codec<T.SessionEventType>;

const ToolAction = z.enum(T.ToolActionValues) satisfies Codec<T.ToolAction>;

const EventTokens = z.object({
  input: z.number(),
  cacheRead: z.number(),
  output: z.number(),
  cacheWrite: z.exactOptional(z.number()),
  reasoning: z.exactOptional(z.number()),
  contextUsed: z.exactOptional(z.number()),
  contextWindow: z.exactOptional(z.number()),
}) satisfies Codec<T.EventTokens>;

export const SessionPermissionMode = z.enum(T.SessionPermissionModeValues) satisfies Codec<T.SessionPermissionMode>;

export const SessionPermissionDecision = z.enum(T.SessionPermissionDecisionValues) satisfies Codec<T.SessionPermissionDecision>;

export const SessionPermissionRequest = z.object({
  requestId: z.string(),
  tool: z.string(),
  summary: z.string(),
  input: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionPermissionRequest>;

export const SessionInteractionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.exactOptional(z.string()),
  warning: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionInteractionOption>;

export const SessionInteractionRequest = z.object({
  requestId: z.string(),
  question: z.string(),
  options: z.array(SessionInteractionOption),
  allowCustom: z.boolean(),
}) satisfies Codec<T.SessionInteractionRequest>;

export const SessionInteractionResolution = z.object({
  requestId: z.string(),
  accepted: z.boolean(),
  choice: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionInteractionResolution>;

export const SessionEvent = z.object({
  seq: z.number(),
  revision: z.number(),
  time: z.number(),
  type: SessionEventType,
  run: z.exactOptional(z.string()),
  call: z.exactOptional(z.number()),
  under: z.exactOptional(z.number()),
  threadId: z.exactOptional(z.string()),
  text: z.string(),
  action: z.exactOptional(ToolAction),
  actionText: z.exactOptional(z.string()),
  tool: z.exactOptional(z.string()),
  input: z.exactOptional(z.string()),
  output: z.exactOptional(z.string()),
  ok: z.exactOptional(z.boolean()),
  tokens: z.exactOptional(EventTokens),
  connection: z.exactOptional(ToolConnection),
  permission: z.exactOptional(SessionPermissionRequest),
  interaction: z.exactOptional(SessionInteractionRequest),
  interactionResolution: z.exactOptional(SessionInteractionResolution),
}) satisfies Codec<T.SessionEvent>;

export const SessionContextFile = z.object({
  path: z.string(),
  startLine: z.exactOptional(z.number()),
  endLine: z.exactOptional(z.number()),
}) satisfies Codec<T.SessionContextFile>;

export const SessionWorkspace = z.object({
  id: SessionId,
  session: Session,
  model: z.exactOptional(z.string()),
  effort: z.exactOptional(z.string()),
  permissionMode: SessionPermissionMode,
}) satisfies Codec<T.SessionWorkspace>;

export const SessionWatchEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("state"),
    session: Session,
    model: z.exactOptional(z.string()),
    effort: z.exactOptional(z.string()),
    permissionMode: SessionPermissionMode,
    pendingPermissions: z.array(SessionPermissionRequest),
    pendingInteractions: z.array(SessionInteractionRequest),
    tokens: z.exactOptional(EventTokens),
  }),
  z.object({
    kind: z.literal("history"),
    session: SessionId,
    events: z.array(SessionEvent),
  }),
  z.object({
    kind: z.literal("event"),
    session: SessionId,
    event: SessionEvent,
  }),
  z.object({
    kind: z.literal("missing"),
    session: SessionId,
  }),
]) satisfies Codec<T.SessionWatchEvent>;

const RunTriggerKind = z.enum(T.RunTriggerKindValues) satisfies Codec<T.RunTriggerKind>;

export const RunTrigger = z.object({
  kind: RunTriggerKind,
  message: z.exactOptional(z.string()),
  channel: z.exactOptional(z.string()),
  cron: z.exactOptional(z.string()),
  missed: z.exactOptional(z.boolean()),
}) satisfies Codec<T.RunTrigger>;

export const Run = z.object({
  needsReconciliation: z.exactOptional(z.boolean()),
  id: z.string(),
  session: SessionId,
  issue: z.exactOptional(IssueId),
  subagents: z.exactOptional(SessionSubagents),
  triggeredBy: RunTrigger,
  heard: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.exactOptional(z.number()),
  outcome: z.exactOptional(Outcome),
  summary: z.string(),
  spent: z.exactOptional(Spent),
}) satisfies Codec<T.Run>;

export const FactSessionSubagentsChanged = z.object({
  type: z.literal("sessionSubagentsChanged"),
  at: z.number(),
  id: SessionId,
  subagents: z.exactOptional(SessionSubagents),
}) satisfies Codec<T.FactSessionSubagentsChanged>;

export const FactSessionPhaseChanged = z.object({
  type: z.literal("sessionPhaseChanged"),
  at: z.number(),
  id: SessionId,
  phase: Phase,
  channel: z.exactOptional(z.string()),
  spent: z.exactOptional(Spent),
  brief: z.exactOptional(z.string()),
}) satisfies Codec<T.FactSessionPhaseChanged>;

export const FactSessionChanged = z.object({
  type: z.literal("sessionChanged"),
  at: z.number(),
  session: Session,
}) satisfies Codec<T.FactSessionChanged>;

export const FactSessionLeft = z.object({
  type: z.literal("sessionLeft"),
  at: z.number(),
  id: SessionId,
  closed: z.exactOptional(SessionClose),
  merged: z.exactOptional(z.number()),
}) satisfies Codec<T.FactSessionLeft>;

export const FactSessionToolChanged = z.object({
  type: z.literal("sessionToolChanged"),
  at: z.number(),
  id: SessionId,
  connection: ToolConnection,
}) satisfies Codec<T.FactSessionToolChanged>;

export const FactSessionToolsReset = z.object({
  type: z.literal("sessionToolsReset"),
  at: z.number(),
  id: SessionId,
}) satisfies Codec<T.FactSessionToolsReset>;

export const Machine = z.object({
  id: z.string(),
  name: z.string(),
  here: z.boolean(),
  online: z.boolean(),
  joinedAt: z.number(),
}) satisfies Codec<T.Machine>;

export const FactMachineChanged = z.object({
  type: z.literal("machineChanged"),
  at: z.number(),
  machine: Machine,
}) satisfies Codec<T.FactMachineChanged>;
