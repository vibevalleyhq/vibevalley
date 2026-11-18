import { z } from "zod";

import { Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactUserMentionsChanged } from "../channel/schema";
import type { Codec } from "../codec";
import { SessionId } from "../common/schema";
import { ConnectorStatus, FactConnectorChanged } from "../connector/schema";
import { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/schema";
import { CommitCount, FactProgressChanged, FarmView, GameEffect, Progress, SessionPlay } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/schema";
import { MediaJob, FactMediaChanged } from "../media/schema";
import { RuntimeInfo } from "../runtime/schema";
import {
  FactMachineChanged,
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionChanged,
  FactSessionLeft,
  FactSessionPhaseChanged,
  Machine,
  Session,
  SessionEvent,
  SessionView,
} from "../session/schema";
import { CallState, FactCallChanged } from "../voice/schema";
import * as T from "./shapes";

const spaceFields = {
  call: CallState,
  callReason: z.string(),
  media: z.exactOptional(z.array(MediaJob)),
  chat: z.exactOptional(Chat),
  commits: z.exactOptional(CommitCount),
  progress: z.exactOptional(Progress),
  issues: z.array(Issue),
  connectors: z.array(ConnectorStatus),
  machines: z.array(Machine),
};

const SpaceState = z.object({
  ...spaceFields,
  sessions: z.array(Session),
  crons: z.array(Cron),
  plays: z.exactOptional(z.record(z.string(), SessionPlay)),
}) satisfies Codec<T.SpaceState>;

const SpaceView = z.object({
  ...spaceFields,
  sessions: z.array(SessionView),
  crons: z.array(CronView),
}) satisfies Codec<T.SpaceView>;

const NoticeLevel = z.enum(T.NoticeLevelValues) satisfies Codec<T.NoticeLevel>;

export const StateFrame = z.object({
  seq: z.number(),
  state: SpaceView,
  inbox: z.array(InboxItem),
  view: FarmView,
  effects: z.array(GameEffect),
}) satisfies Codec<T.StateFrame>;

export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
}) satisfies Codec<T.Health>;

export const Fact = z.discriminatedUnion("type", [
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
]) satisfies Codec<T.Fact>;

const ServerEventSnapshot = z.object({
  type: z.literal("snapshot"),
  at: z.number(),
  state: SpaceState,
}) satisfies Codec<T.ServerEventSnapshot>;

const LiveEventSession = z.object({
  type: z.literal("event"),
  at: z.number(),
  id: SessionId,
  activity: SessionEvent,
}) satisfies Codec<T.LiveEventSession>;

const LiveEventNotice = z.object({
  type: z.literal("notice"),
  at: z.number(),
  level: NoticeLevel,
  text: z.string(),
}) satisfies Codec<T.LiveEventNotice>;

const LiveEventRuntime = z.object({
  type: z.literal("runtime"),
  at: z.number(),
  info: RuntimeInfo,
}) satisfies Codec<T.LiveEventRuntime>;

export const LiveEvent = z.discriminatedUnion("type", [LiveEventSession, LiveEventNotice, LiveEventRuntime]) satisfies Codec<T.LiveEvent>;

export const ServerEvent = z.discriminatedUnion("type", [
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
]) satisfies Codec<T.ServerEvent>;
