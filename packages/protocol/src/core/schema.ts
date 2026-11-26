import { z } from "zod";

import { ChannelSummary, Chat } from "../channel/schema";
import type { Codec } from "../codec";
import { IssueId, SessionId } from "../common/schema";
import { ConnectorStatus } from "../connector/schema";
import { CronView } from "../cron/schema";
import { CommitCount, FarmFrame } from "../game/schema";
import { InboxItem } from "../inbox/schema";
import { BoardSummary, Issue, IssueStatus } from "../issue/schema";
import { MediaJob, MediaSummary } from "../media/schema";
import { RuntimeInfo } from "../runtime/schema";
import { Machine, SessionEvent, SessionView } from "../session/schema";
import { CallState } from "../voice/schema";
import * as T from "./shapes";

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

export type SliceDecoderMap = { readonly [K in T.SliceKind]: z.ZodType<T.SliceMap[K]> };

export const sliceDecoders: SliceDecoderMap = {
  board: BoardSlice,
  sessions: SessionsSlice,
  collab: CollabSlice,
  inbox: InboxSlice,
  ops: OpsSlice,
  farm: FarmFrame,
};

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

export const RetroWindow = z.enum(T.RetroWindowValues) satisfies Codec<T.RetroWindow>;

export const IssueRetroGetInput = z.object({
  window: z.exactOptional(RetroWindow),
}) satisfies Codec<T.IssueRetroGetInput>;

export const RetroDurationStats = z.object({
  sampleCount: z.number(),
  medianMs: z.exactOptional(z.number()),
  p90Ms: z.exactOptional(z.number()),
}) satisfies Codec<T.RetroDurationStats>;

export const RetroOverdueItem = z.object({
  id: IssueId,
  number: z.number(),
  title: z.string(),
  status: IssueStatus,
  repo: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  dueAt: z.number(),
  closedAt: z.exactOptional(z.number()),
  overdueMs: z.number(),
}) satisfies Codec<T.RetroOverdueItem>;

export const RetroReworkItem = z.object({
  id: IssueId,
  number: z.number(),
  title: z.string(),
  status: IssueStatus,
  repo: z.exactOptional(z.string()),
  agent: z.exactOptional(z.string()),
  findingsCount: z.number(),
  unresolvedCount: z.number(),
}) satisfies Codec<T.RetroReworkItem>;

export const RetroBreakdownBucket = z.object({
  key: z.string(),
  totalCount: z.number(),
  completedCount: z.number(),
  canceledCount: z.number(),
  overdueCount: z.number(),
  reworkCount: z.number(),
  medianCycleMs: z.exactOptional(z.number()),
}) satisfies Codec<T.RetroBreakdownBucket>;

export const IssueRetroReport = z.object({
  window: RetroWindow,
  generatedAt: z.number(),
  windowStartAt: z.exactOptional(z.number()),
  totalIssues: z.number(),
  openCount: z.number(),
  completedCount: z.number(),
  canceledCount: z.number(),
  completionRatePct: z.exactOptional(z.number()),
  cycleTime: RetroDurationStats,
  reviewWait: RetroDurationStats,
  withDueCount: z.number(),
  withoutDueCount: z.number(),
  onTimeCount: z.number(),
  overdueCount: z.number(),
  upcomingDueCount: z.number(),
  onTimeRatePct: z.exactOptional(z.number()),
  overdueRatePct: z.exactOptional(z.number()),
  reworkIssueCount: z.number(),
  totalFindingsCount: z.number(),
  unresolvedFindingsCount: z.number(),
  reworkRatePct: z.exactOptional(z.number()),
  overdueItems: z.array(RetroOverdueItem),
  reworkItems: z.array(RetroReworkItem),
  byRepo: z.array(RetroBreakdownBucket),
  byTag: z.array(RetroBreakdownBucket),
  byAgent: z.array(RetroBreakdownBucket),
}) satisfies Codec<T.IssueRetroReport>;
