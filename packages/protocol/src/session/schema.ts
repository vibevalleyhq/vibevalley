import { Schema } from "effect";

import { AgentRoleValues } from "../agent/shapes";
import type { Codec } from "../codec";
import { IssueId, Outcome, Retry, SessionId, Spent } from "../common/schema";
import * as T from "./shapes";

const SessionAction: Codec<T.SessionAction> = Schema.Literals(T.SessionActionValues);

export const doingFields = {
  action: SessionAction,
  label: Schema.String,
};

const Doing: Codec<T.Doing> = Schema.Struct(doingFields);

const DoingView: Codec<T.DoingView> = Schema.Struct({ ...doingFields, actionText: Schema.String });

const workingFields = {
  since: Schema.Finite,
  quietSince: Schema.optionalKey(Schema.Finite),
  retry: Schema.optionalKey(Retry),
};

const PhaseWorking: Codec<T.PhaseWorking> = Schema.TaggedStruct("working", { ...workingFields, doing: Doing });

const PhaseWorkingView: Codec<T.PhaseWorkingView> = Schema.TaggedStruct("working", { ...workingFields, doing: DoingView });

const PhaseDone: Codec<T.PhaseDone> = Schema.TaggedStruct("done", {});

const PhaseFailed: Codec<T.PhaseFailed> = Schema.TaggedStruct("failed", {});

export const PhaseResting: Codec<T.PhaseResting> = Schema.TaggedStruct("resting", {});

const SessionClose: Codec<T.SessionClose> = Schema.Literals(T.SessionCloseValues);

const PhaseClosed: Codec<T.PhaseClosed> = Schema.TaggedStruct("closed", {
  at: Schema.Finite,
  closed: SessionClose,
});

export const Phase: Codec<T.Phase> = Schema.Union([PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

const PhaseView: Codec<T.PhaseView> = Schema.Union([PhaseWorkingView, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const IssueAnswer: Codec<T.IssueAnswer> = Schema.Struct({
  conclusion: Schema.String,
  evidence: Schema.mutable(Schema.Array(Schema.String)),
  unsure: Schema.mutable(Schema.Array(Schema.String)),
  next: Schema.mutable(Schema.Array(Schema.String)),
});

export const LastRun: Codec<T.LastRun> = Schema.Struct({
  outcome: Outcome,
  summary: Schema.String,
  at: Schema.Finite,
  spent: Schema.optionalKey(Spent),
  answer: Schema.optionalKey(IssueAnswer),
});

const ToolConnection: Codec<T.ToolConnection> = Schema.Struct({
  server: Schema.String,
  status: Schema.Literals(T.ToolConnectionStatusValues),
  reason: Schema.optionalKey(Schema.String),
});

const sessionFields = {
  id: SessionId,
  role: Schema.Literals(AgentRoleValues),
  name: Schema.String,
  agent: Schema.String,
  runtime: Schema.String,
  brief: Schema.String,
  repo: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.String),
  hiredAt: Schema.Finite,
  runs: Schema.Finite,
  lastRun: Schema.optionalKey(LastRun),
  spent: Schema.optionalKey(Spent),
  channel: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(IssueId),
  refining: Schema.Boolean,
  toolConnections: Schema.optionalKey(Schema.mutable(Schema.Array(ToolConnection))),
  machine: Schema.optionalKey(Schema.String),
};

export const Session: Codec<T.Session> = Schema.Struct({ ...sessionFields, phase: Phase });

export const SessionView: Codec<T.SessionView> = Schema.Struct({
  ...sessionFields,
  phase: PhaseView,
  phaseText: Schema.String,
});

const SessionEventType: Codec<T.SessionEventType> = Schema.Literals(T.SessionEventTypeValues);

const ToolAction: Codec<T.ToolAction> = Schema.Literals(T.ToolActionValues);

const EventTokens: Codec<T.EventTokens> = Schema.Struct({
  input: Schema.Finite,
  cacheRead: Schema.Finite,
  output: Schema.Finite,
});

export const SessionEvent: Codec<T.SessionEvent> = Schema.Struct({
  seq: Schema.Finite,
  revision: Schema.Finite,
  time: Schema.Finite,
  type: SessionEventType,
  run: Schema.optionalKey(Schema.String),
  call: Schema.optionalKey(Schema.Finite),
  under: Schema.optionalKey(Schema.Finite),
  text: Schema.String,
  action: Schema.optionalKey(ToolAction),
  actionText: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.String),
  ok: Schema.optionalKey(Schema.Boolean),
  tokens: Schema.optionalKey(EventTokens),
  connection: Schema.optionalKey(ToolConnection),
});

const RunTriggerKind: Codec<T.RunTriggerKind> = Schema.Literals(T.RunTriggerKindValues);

export const RunTrigger: Codec<T.RunTrigger> = Schema.Struct({
  kind: RunTriggerKind,
  message: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  cron: Schema.optionalKey(Schema.String),
  missed: Schema.optionalKey(Schema.Boolean),
});

export const Run: Codec<T.Run> = Schema.Struct({
  id: Schema.String,
  session: SessionId,
  issue: Schema.optionalKey(IssueId),
  triggeredBy: RunTrigger,
  heard: Schema.mutable(Schema.Array(Schema.String)),
  startedAt: Schema.Finite,
  endedAt: Schema.optionalKey(Schema.Finite),
  outcome: Schema.optionalKey(Outcome),
  summary: Schema.String,
  spent: Schema.optionalKey(Spent),
});

export const FactSessionPhaseChanged: Codec<T.FactSessionPhaseChanged> = Schema.Struct({
  type: Schema.Literal("sessionPhaseChanged"),
  at: Schema.Finite,
  id: SessionId,
  phase: Phase,
  channel: Schema.optionalKey(Schema.String),
  spent: Schema.optionalKey(Spent),
  brief: Schema.optionalKey(Schema.String),
});

export const FactSessionChanged: Codec<T.FactSessionChanged> = Schema.Struct({
  type: Schema.Literal("sessionChanged"),
  at: Schema.Finite,
  session: Session,
});

export const FactSessionLeft: Codec<T.FactSessionLeft> = Schema.Struct({
  type: Schema.Literal("sessionLeft"),
  at: Schema.Finite,
  id: SessionId,
  closed: Schema.optionalKey(SessionClose),
  merged: Schema.optionalKey(Schema.Finite),
});

export const FactSessionToolChanged: Codec<T.FactSessionToolChanged> = Schema.Struct({
  type: Schema.Literal("sessionToolChanged"),
  at: Schema.Finite,
  id: SessionId,
  connection: ToolConnection,
});

export const FactSessionToolsReset: Codec<T.FactSessionToolsReset> = Schema.Struct({
  type: Schema.Literal("sessionToolsReset"),
  at: Schema.Finite,
  id: SessionId,
});
