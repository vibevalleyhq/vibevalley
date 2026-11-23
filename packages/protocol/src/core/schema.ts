import { z } from "zod";

import { ChannelSummary, Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactUserMentionsChanged } from "../channel/schema";
import type { Codec } from "../codec";
import { SessionId } from "../common/schema";
import { ConnectorStatus, FactConnectorChanged } from "../connector/schema";
import { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/schema";
import { CommitCount, FactProgressChanged, FarmFrame, Progress, SessionPlay } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { BoardSummary, FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/schema";
import { MediaJob, MediaSummary, FactMediaChanged } from "../media/schema";
import { RuntimeInfo } from "../runtime/schema";
import {
  FactMachineChanged,
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionChanged,
  FactSessionLeft,
  FactSessionSubagentsChanged,
  FactSessionPhaseChanged,
  Machine,
  Session,
  SessionEvent,
  SessionView,
} from "../session/schema";
import { CallState, FactCallChanged } from "../voice/schema";
import * as T from "./shapes";

const SpaceState = z.object({
  call: CallState,
  callReason: z.string(),
  media: z.exactOptional(z.array(MediaJob)),
  chat: z.exactOptional(Chat),
  commits: z.exactOptional(CommitCount),
  progress: z.exactOptional(Progress),
  issues: z.array(Issue),
  connectors: z.array(ConnectorStatus),
  machines: z.array(Machine),
  sessions: z.array(Session),
  crons: z.array(Cron),
  plays: z.exactOptional(z.record(z.string(), SessionPlay)),
}) satisfies Codec<T.SpaceState>;

export const SliceKind = z.enum(T.SliceKindValues) satisfies Codec<T.SliceKind>;

const NoticeLevel = z.enum(T.NoticeLevelValues) satisfies Codec<T.NoticeLevel>;

export const BoardSlice = z.object({
  seq: z.number(),
  issues: z.array(Issue),
  boardSummary: z.exactOptional(BoardSummary),
  commits: z.exactOptional(CommitCount),
}) satisfies Codec<T.BoardSlice>;

export const SessionsSlice = z.object({
  seq: z.number(),
  sessions: z.array(SessionView),
  machines: z.array(Machine),
}) satisfies Codec<T.SessionsSlice>;

export const CollabSlice = z.object({
  seq: z.number(),
  chat: z.exactOptional(Chat),
  channelSummary: z.exactOptional(ChannelSummary),
  connectors: z.array(ConnectorStatus),
}) satisfies Codec<T.CollabSlice>;

export const InboxSlice = z.object({
  seq: z.number(),
  items: z.array(InboxItem),
  call: CallState,
  callReason: z.string(),
}) satisfies Codec<T.InboxSlice>;

export const OpsSlice = z.object({
  seq: z.number(),
  crons: z.array(CronView),
  media: z.exactOptional(z.array(MediaJob)),
  mediaSummary: z.exactOptional(MediaSummary),
}) satisfies Codec<T.OpsSlice>;

export const SliceBundle = z.object({
  seq: z.number(),
  board: BoardSlice,
  sessions: SessionsSlice,
  collab: CollabSlice,
  inbox: InboxSlice,
  ops: OpsSlice,
  farm: FarmFrame,
}) satisfies Codec<T.SliceBundle>;

export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
}) satisfies Codec<T.Health>;

export const Fact = z.discriminatedUnion("type", [
  FactCallChanged,
  FactSessionToolChanged,
  FactSessionToolsReset,
  FactSessionSubagentsChanged,
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
  FactSessionSubagentsChanged,
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
