import { z } from "zod";

import type { Codec } from "../codec";
import { ArtifactId, IssueId, Outcome, Retry, SessionId, Spent } from "../common/schema";
import { AgentRoleValues } from "../common/shapes.gen";
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

const PhaseResting = z.object({ _tag: z.literal("resting") }) satisfies Codec<T.PhaseResting>;

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

export const SessionPermissionMode = z.enum(T.SessionPermissionModeValues) satisfies Codec<T.SessionPermissionMode>;

export const SessionController = z.enum(T.SessionControllerValues) satisfies Codec<T.SessionController>;

const ExecutionPolicy = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("directCwd"),
    repo: z.exactOptional(z.string()),
    permissionMode: SessionPermissionMode,
  }),
  z.object({
    kind: z.literal("managedWorktree"),
    repo: z.string(),
    branch: z.exactOptional(z.string()),
  }),
  z.object({
    kind: z.literal("sandboxDir"),
  }),
]) satisfies Codec<T.ExecutionPolicy>;

export const ContextRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue"),
    id: IssueId,
    refining: z.exactOptional(z.boolean()),
  }),
  z.object({
    kind: z.literal("channel"),
    id: z.string(),
  }),
  z.object({
    kind: z.literal("artifact"),
    id: ArtifactId,
  }),
  z.object({
    kind: z.literal("pkm"),
    path: z.string(),
  }),
]) satisfies Codec<T.ContextRef>;

const sessionFields = {
  id: SessionId,
  controller: SessionController,
  role: z.exactOptional(z.enum(AgentRoleValues)),
  name: z.string(),
  profile: z.exactOptional(z.string()),
  runtime: z.string(),
  brief: z.string(),
  cwd: z.exactOptional(z.string()),
  policy: ExecutionPolicy,
  bindings: z.array(ContextRef),
  hiredAt: z.number(),
  runs: z.number(),
  lastRun: z.exactOptional(LastRun),
  spent: z.exactOptional(Spent),
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

export const EventTokens = z.object({
  input: z.number(),
  cacheRead: z.number(),
  output: z.number(),
  cacheWrite: z.exactOptional(z.number()),
  reasoning: z.exactOptional(z.number()),
  contextUsed: z.exactOptional(z.number()),
  contextWindow: z.exactOptional(z.number()),
}) satisfies Codec<T.EventTokens>;

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

export const SessionEventPage = z.object({
  events: z.array(SessionEvent),
  hasMore: z.boolean(),
  oldestSeq: z.exactOptional(z.number()),
  newestSeq: z.exactOptional(z.number()),
}) satisfies Codec<T.SessionEventPage>;

export const SessionBindingInput = z.object({
  id: z.string(),
  binding: ContextRef,
}) satisfies Codec<T.SessionBindingInput>;

export const SessionContextFile = z.object({
  path: z.string(),
  startLine: z.exactOptional(z.number()),
  endLine: z.exactOptional(z.number()),
}) satisfies Codec<T.SessionContextFile>;

export const SessionWorkspace = z.object({
  id: SessionId,
  session: Session,
  title: z.exactOptional(z.string()),
  model: z.exactOptional(z.string()),
  effort: z.exactOptional(z.string()),
  permissionMode: SessionPermissionMode,
}) satisfies Codec<T.SessionWorkspace>;

const SessionSwarmRole = z.enum(T.SessionSwarmRoleValues) satisfies Codec<T.SessionSwarmRole>;

const SessionSwarmMemberState = z.enum(T.SessionSwarmMemberStateValues) satisfies Codec<T.SessionSwarmMemberState>;

const SessionSwarmMember = z.object({
  name: z.string(),
  conversationId: z.string(),
  role: SessionSwarmRole,
  state: SessionSwarmMemberState,
  wakeMode: z.exactOptional(z.string()),
  waitSince: z.exactOptional(z.number()),
  model: z.exactOptional(z.string()),
  workspaceMode: z.exactOptional(z.string()),
  task: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionSwarmMember>;

const SessionSwarmThread = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.exactOptional(z.string()),
  members: z.array(z.string()),
}) satisfies Codec<T.SessionSwarmThread>;

const SessionSwarmOverview = z.object({
  goalTitle: z.exactOptional(z.string()),
  goalLine: z.exactOptional(z.string()),
  threads: z.array(SessionSwarmThread),
  tasks: z.record(z.string(), z.string()),
}) satisfies Codec<T.SessionSwarmOverview>;

const SessionSwarmMessage = z.object({
  seq: z.number(),
  agent: z.string(),
  text: z.string(),
  time: z.string(),
  kind: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionSwarmMessage>;

const SessionSwarmState = z.object({
  swarmId: z.string(),
  title: z.exactOptional(z.string()),
  workingCount: z.number(),
  activeCount: z.number(),
  members: z.array(SessionSwarmMember),
  overview: z.exactOptional(SessionSwarmOverview),
  messages: z.array(SessionSwarmMessage),
  totalMessages: z.number(),
}) satisfies Codec<T.SessionSwarmState>;

const SessionChildToolCall = z.object({
  name: z.string(),
  args: z.exactOptional(z.string()),
}) satisfies Codec<T.SessionChildToolCall>;

const SessionChildStep = z.object({
  stepIndex: z.number(),
  source: z.string(),
  kind: z.string(),
  status: z.exactOptional(z.string()),
  createdAt: z.exactOptional(z.string()),
  model: z.exactOptional(z.string()),
  thinking: z.exactOptional(z.string()),
  content: z.exactOptional(z.string()),
  error: z.exactOptional(z.string()),
  toolCalls: z.array(SessionChildToolCall),
  inputTokens: z.exactOptional(z.number()),
  cacheReadTokens: z.exactOptional(z.number()),
  outputTokens: z.exactOptional(z.number()),
}) satisfies Codec<T.SessionChildStep>;

export const SessionChildTranscript = z.object({
  conversationId: z.string(),
  steps: z.array(SessionChildStep),
}) satisfies Codec<T.SessionChildTranscript>;

export const SessionWatchEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("state"),
    session: Session,
    title: z.exactOptional(z.string()),
    model: z.exactOptional(z.string()),
    effort: z.exactOptional(z.string()),
    permissionMode: SessionPermissionMode,
    pendingPermissions: z.array(SessionPermissionRequest),
    pendingInteractions: z.array(SessionInteractionRequest),
    tokens: z.exactOptional(EventTokens),
    swarm: z.exactOptional(SessionSwarmState),
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

export const Machine = z.object({
  id: z.string(),
  name: z.string(),
  here: z.boolean(),
  online: z.boolean(),
  joinedAt: z.number(),
}) satisfies Codec<T.Machine>;
