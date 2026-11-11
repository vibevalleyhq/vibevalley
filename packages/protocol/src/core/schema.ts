import { Schema } from "effect";

import { Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactUserMentionsChanged } from "../channel/schema";
import type { Codec } from "../codec";
import { SessionId } from "../common/schema";
import { ConnectorStatus, FactConnectorChanged } from "../connector/schema";
import { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/schema";
import { CommitCount, FactProgressChanged, FarmView, GameEffect, Progress, SessionPlay } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/schema";
import { FactMachineChanged, Machine } from "../machine/schema";
import { MediaJob, FactMediaChanged } from "../media/schema";
import { RuntimeInfo } from "../runtime/schema";
import {
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionChanged,
  FactSessionLeft,
  FactSessionPhaseChanged,
  Session,
  SessionEvent,
  SessionView,
} from "../session/schema";
import { CallState, FactCallChanged } from "../voice/schema";
import * as T from "./shapes";

const spaceFields = {
  call: CallState,
  callReason: Schema.String,
  media: Schema.optionalKey(Schema.mutable(Schema.Array(MediaJob))),
  chat: Schema.optionalKey(Chat),
  commits: Schema.optionalKey(CommitCount),
  progress: Schema.optionalKey(Progress),
  issues: Schema.mutable(Schema.Array(Issue)),
  connectors: Schema.mutable(Schema.Array(ConnectorStatus)),
  machines: Schema.mutable(Schema.Array(Machine)),
};

const SpaceState: Codec<T.SpaceState> = Schema.Struct({
  ...spaceFields,
  sessions: Schema.mutable(Schema.Array(Session)),
  crons: Schema.mutable(Schema.Array(Cron)),
  plays: Schema.optionalKey(Schema.Record(Schema.String, SessionPlay)),
});

const SpaceView: Codec<T.SpaceView> = Schema.Struct({
  ...spaceFields,
  sessions: Schema.mutable(Schema.Array(SessionView)),
  crons: Schema.mutable(Schema.Array(CronView)),
});

const NoticeLevel: Codec<T.NoticeLevel> = Schema.Literals(T.NoticeLevelValues);

export const StateFrame: Codec<T.StateFrame> = Schema.Struct({
  seq: Schema.Finite,
  state: SpaceView,
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
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionPhaseChanged,
  FactMessageChanged,
  FactChannelChanged,
  FactUserMentionsChanged,
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
  FactMachineChanged,
  FactMediaChanged,
]);

const ServerEventSnapshot: Codec<T.ServerEventSnapshot> = Schema.Struct({
  type: Schema.Literal("snapshot"),
  at: Schema.Finite,
  state: SpaceState,
});

const LiveEventSession: Codec<T.LiveEventSession> = Schema.Struct({
  type: Schema.Literal("event"),
  at: Schema.Finite,
  id: SessionId,
  activity: SessionEvent,
});

const LiveEventNotice: Codec<T.LiveEventNotice> = Schema.Struct({
  type: Schema.Literal("notice"),
  at: Schema.Finite,
  level: NoticeLevel,
  text: Schema.String,
});

const LiveEventRuntime: Codec<T.LiveEventRuntime> = Schema.Struct({
  type: Schema.Literal("runtime"),
  at: Schema.Finite,
  info: RuntimeInfo,
});

export const LiveEvent: Codec<T.LiveEvent> = Schema.Union([LiveEventSession, LiveEventNotice, LiveEventRuntime]);

export const ServerEvent: Codec<T.ServerEvent> = Schema.Union([
  FactCallChanged,
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionPhaseChanged,
  FactMessageChanged,
  FactChannelChanged,
  FactUserMentionsChanged,
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
  FactMachineChanged,
  FactMediaChanged,
  ServerEventSnapshot,
  LiveEventSession,
  LiveEventNotice,
  LiveEventRuntime,
]);
