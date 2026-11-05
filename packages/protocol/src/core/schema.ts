import { Schema } from "effect";

import { Channel, Chat, ChatMessage, OwnerMention } from "../channel/schema";
import type { Codec } from "../codec";
import { IssueId, Outcome, SessionId, Spent } from "../common/schema";
import { ConnectorStatus } from "../connector/schema";
import { Cron, CronView } from "../cron/schema";
import { CommitCount, FarmView, GameEffect, Progress, ProgressNews, SessionPlay } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { CriterionCheck, Issue, Question } from "../issue/schema";
import { RuntimeInfo } from "../runtime/schema";
import { IssueAnswer, Phase, PhaseResting, Session, SessionClose, SessionEvent, SessionView } from "../session/schema";
import * as T from "../shapes";
import { CallState } from "../voice/schema";

const workspaceFields = {
  call: CallState,
  callReason: Schema.String,
  chat: Schema.optionalKey(Chat),
  commits: Schema.optionalKey(CommitCount),
  progress: Schema.optionalKey(Progress),
  issues: Schema.mutable(Schema.Array(Issue)),
  connectors: Schema.mutable(Schema.Array(ConnectorStatus)),
};

export const WorkspaceState: Codec<T.WorkspaceState> = Schema.Struct({
  ...workspaceFields,
  sessions: Schema.mutable(Schema.Array(Session)),
  crons: Schema.mutable(Schema.Array(Cron)),
  plays: Schema.optionalKey(Schema.Record(Schema.String, SessionPlay)),
});

export const WorkspaceView: Codec<T.WorkspaceView> = Schema.Struct({
  ...workspaceFields,
  sessions: Schema.mutable(Schema.Array(SessionView)),
  crons: Schema.mutable(Schema.Array(CronView)),
});

export const NoticeLevel: Codec<T.NoticeLevel> = Schema.Literals(T.NoticeLevelValues);

export const StateFrame: Codec<T.StateFrame> = Schema.Struct({
  seq: Schema.Finite,
  state: WorkspaceView,
  inbox: Schema.mutable(Schema.Array(InboxItem)),
  view: FarmView,
  effects: Schema.mutable(Schema.Array(GameEffect)),
});

export const Health: Codec<T.Health> = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
});

export const FactCallChanged: Codec<T.FactCallChanged> = Schema.Struct({
  type: Schema.Literal("callChanged"),
  at: Schema.Finite,
  state: CallState,
  reason: Schema.String,
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

export const FactMessageChanged: Codec<T.FactMessageChanged> = Schema.Struct({
  type: Schema.Literal("messageChanged"),
  at: Schema.Finite,
  message: ChatMessage,
  thread: Schema.optionalKey(Schema.String),
  answers: Schema.optionalKey(SessionId),
});

export const FactChannelChanged: Codec<T.FactChannelChanged> = Schema.Struct({
  type: Schema.Literal("channelChanged"),
  at: Schema.Finite,
  channel: Channel,
});

export const FactOwnerMentionsChanged: Codec<T.FactOwnerMentionsChanged> = Schema.Struct({
  type: Schema.Literal("ownerMentionsChanged"),
  at: Schema.Finite,
  mentions: Schema.mutable(Schema.Array(OwnerMention)),
});

export const FactSessionChanged: Codec<T.FactSessionChanged> = Schema.Struct({
  type: Schema.Literal("sessionChanged"),
  at: Schema.Finite,
  session: Session,
});

export const FactSessionReported: Codec<T.FactSessionReported> = Schema.Struct({
  type: Schema.Literal("sessionReported"),
  at: Schema.Finite,
  id: SessionId,
  run: Schema.optionalKey(Schema.String),
  outcome: Outcome,
  phase: Schema.optionalKey(PhaseResting),
  summary: Schema.String,
  runs: Schema.Finite,
  spent: Schema.optionalKey(Spent),
  questions: Schema.mutable(Schema.Array(Question)),
  checks: Schema.mutable(Schema.Array(CriterionCheck)),
  answer: Schema.optionalKey(IssueAnswer),
});

export const FactSessionLeft: Codec<T.FactSessionLeft> = Schema.Struct({
  type: Schema.Literal("sessionLeft"),
  at: Schema.Finite,
  id: SessionId,
  closed: Schema.optionalKey(SessionClose),
  merged: Schema.optionalKey(Schema.Finite),
});

export const FactIssueChanged: Codec<T.FactIssueChanged> = Schema.Struct({
  type: Schema.Literal("issueChanged"),
  at: Schema.Finite,
  issue: Issue,
});

export const FactChannelRemoved: Codec<T.FactChannelRemoved> = Schema.Struct({
  type: Schema.Literal("channelRemoved"),
  at: Schema.Finite,
  id: Schema.String,
});

export const FactIssueRemoved: Codec<T.FactIssueRemoved> = Schema.Struct({
  type: Schema.Literal("issueRemoved"),
  at: Schema.Finite,
  id: IssueId,
});

export const FactProgressChanged: Codec<T.FactProgressChanged> = Schema.Struct({
  type: Schema.Literal("progressChanged"),
  at: Schema.Finite,
  progress: Schema.optionalKey(Progress),
  news: Schema.optionalKey(ProgressNews),
  commits: Schema.optionalKey(CommitCount),
  station: Schema.optionalKey(Schema.Struct({ id: SessionId, station: Schema.Finite })),
});

export const FactCronChanged: Codec<T.FactCronChanged> = Schema.Struct({
  type: Schema.Literal("cronChanged"),
  at: Schema.Finite,
  cron: Cron,
});

export const FactCronRemoved: Codec<T.FactCronRemoved> = Schema.Struct({
  type: Schema.Literal("cronRemoved"),
  at: Schema.Finite,
  id: Schema.String,
});

export const FactConnectorChanged: Codec<T.FactConnectorChanged> = Schema.Struct({
  type: Schema.Literal("connectorChanged"),
  at: Schema.Finite,
  status: ConnectorStatus,
});

export const Fact: Codec<T.Fact> = Schema.Union([
  FactCallChanged,
  FactSessionPhaseChanged,
  FactMessageChanged,
  FactChannelChanged,
  FactOwnerMentionsChanged,
  FactSessionChanged,
  FactSessionReported,
  FactSessionLeft,
  FactProgressChanged,
  FactIssueChanged,
  FactIssueRemoved,
  FactChannelRemoved,
  FactCronChanged,
  FactCronRemoved,
  FactConnectorChanged,
]);

export const ServerEventSnapshot: Codec<T.ServerEventSnapshot> = Schema.Struct({
  type: Schema.Literal("snapshot"),
  at: Schema.Finite,
  state: WorkspaceState,
});

export const ServerEventStep: Codec<T.ServerEventStep> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Finite,
  id: Schema.String,
  activity: SessionEvent,
});

export const ServerEventNotice: Codec<T.ServerEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Finite,
  level: NoticeLevel,
  text: Schema.String,
});

export const ServerEventRuntime: Codec<T.ServerEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Finite,
  info: RuntimeInfo,
});

export const ServerEvent: Codec<T.ServerEvent> = Schema.Union([
  FactCallChanged,
  FactSessionPhaseChanged,
  FactMessageChanged,
  FactChannelChanged,
  FactOwnerMentionsChanged,
  FactSessionChanged,
  FactSessionReported,
  FactSessionLeft,
  FactProgressChanged,
  FactIssueChanged,
  FactIssueRemoved,
  FactChannelRemoved,
  FactCronChanged,
  FactCronRemoved,
  FactConnectorChanged,
  ServerEventSnapshot,
  ServerEventStep,
  ServerEventNotice,
  ServerEventRuntime,
]);

export const LiveEventSession: Codec<T.LiveEventSession> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Finite,
  id: Schema.String,
  activity: SessionEvent,
});

export const LiveEventNotice: Codec<T.LiveEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Finite,
  level: NoticeLevel,
  text: Schema.String,
});

export const LiveEventRuntime: Codec<T.LiveEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Finite,
  info: RuntimeInfo,
});

export const LiveEvent: Codec<T.LiveEvent> = Schema.Union([LiveEventSession, LiveEventNotice, LiveEventRuntime]);
