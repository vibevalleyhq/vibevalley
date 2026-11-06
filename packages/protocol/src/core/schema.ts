import { Schema } from "effect";

import { Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactOwnerMentionsChanged } from "../channel/schema";
import type { Codec } from "../codec";
import { ConnectorStatus, FactConnectorChanged } from "../connector/schema";
import { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/schema";
import { CommitCount, FactProgressChanged, FarmView, GameEffect, Progress, SessionPlay } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/schema";
import { RuntimeInfo } from "../runtime/schema";
import { FactSessionChanged, FactSessionLeft, FactSessionPhaseChanged, Session, SessionEvent, SessionView } from "../session/schema";
import * as T from "../shapes";
import { CallState, FactCallChanged } from "../voice/schema";

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
