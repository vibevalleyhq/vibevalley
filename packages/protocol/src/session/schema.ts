import { Schema } from "effect";

import type { Codec } from "../codec";
import { IssueId, Outcome, Retry, SessionId, Spent } from "../common/schema";
import * as T from "../shapes";

export const SessionAction: Codec<T.SessionAction> = Schema.Literals(T.SessionActionValues);

export const doingFields = {
  action: SessionAction,
  label: Schema.String,
};

export const Doing: Codec<T.Doing> = Schema.Struct(doingFields);

export const DoingView: Codec<T.DoingView> = Schema.Struct({ ...doingFields, actionText: Schema.String });

const workingFields = {
  since: Schema.Finite,
  quietSince: Schema.optionalKey(Schema.Finite),
  retry: Schema.optionalKey(Retry),
};

export const PhaseWorking: Codec<T.PhaseWorking> = Schema.TaggedStruct("working", { ...workingFields, doing: Doing });

export const PhaseWorkingView: Codec<T.PhaseWorkingView> = Schema.TaggedStruct("working", { ...workingFields, doing: DoingView });

export const PhaseDone: Codec<T.PhaseDone> = Schema.TaggedStruct("done", {});

export const PhaseFailed: Codec<T.PhaseFailed> = Schema.TaggedStruct("failed", {});

export const PhaseResting: Codec<T.PhaseResting> = Schema.TaggedStruct("resting", {});

export const SessionClose: Codec<T.SessionClose> = Schema.Literals(T.SessionCloseValues);

export const PhaseClosed: Codec<T.PhaseClosed> = Schema.TaggedStruct("closed", {
  at: Schema.Finite,
  closed: SessionClose,
});

export const Phase: Codec<T.Phase> = Schema.Union([PhaseWorking, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

export const PhaseView: Codec<T.PhaseView> = Schema.Union([PhaseWorkingView, PhaseDone, PhaseFailed, PhaseResting, PhaseClosed]);

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

const sessionFields = {
  id: SessionId,
  role: Schema.Literals(T.AgentRoleValues),
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
};

export const Session: Codec<T.Session> = Schema.Struct({ ...sessionFields, phase: Phase });

export const SessionView: Codec<T.SessionView> = Schema.Struct({
  ...sessionFields,
  phase: PhaseView,
  phaseText: Schema.String,
});

export const SessionEventType: Codec<T.SessionEventType> = Schema.Literals(T.SessionEventTypeValues);

export const ToolAction: Codec<T.ToolAction> = Schema.Literals(T.ToolActionValues);

export const EventTokens: Codec<T.EventTokens> = Schema.Struct({
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
});

export const RunTriggerKind: Codec<T.RunTriggerKind> = Schema.Literals(T.RunTriggerKindValues);

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
