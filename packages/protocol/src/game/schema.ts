import { z } from "zod";

import type { Codec } from "../codec";
import { IssueId, SessionId } from "../common/schema";
import { Repo } from "../repo/schema";
import { doingFields } from "../session/schema";
import * as T from "./shapes";

export const AchievementCategory = z.enum(T.AchievementCategoryValues) satisfies Codec<T.AchievementCategory>;

const AchievementTier = z.object({
  need: z.number(),
  title: z.string(),
  coins: z.number(),
  reached: z.string(),
}) satisfies Codec<T.AchievementTier>;

export const Achievement = z.object({
  id: z.string(),
  category: AchievementCategory,
  title: z.string(),
  detail: z.string(),
  unit: z.exactOptional(z.string()),
  wearable: z.boolean(),
  tiers: z.array(AchievementTier),
}) satisfies Codec<T.Achievement>;

const AchievementStanding = z.object({
  id: z.string(),
  tier: z.number(),
  count: z.number(),
  next: z.exactOptional(z.number()),
}) satisfies Codec<T.AchievementStanding>;

const PlayAction = z.object({ at: z.number(), ...doingFields }) satisfies Codec<T.PlayAction>;

const PlayActionView = z.object({ at: z.number(), ...doingFields, actionText: z.string() }) satisfies Codec<T.PlayActionView>;

const playFields = {
  station: z.number(),
  toolsThisRun: z.number(),
  counts: z.record(z.string(), z.number()),
  files: z.array(z.string()),
  commands: z.array(z.string()),
  runStartedAt: z.exactOptional(z.number()),
};

export const SessionPlay = z.object({ ...playFields, history: z.array(PlayAction) }) satisfies Codec<T.SessionPlay>;

const SessionPlayView = z.object({ ...playFields, history: z.array(PlayActionView) }) satisfies Codec<T.SessionPlayView>;

export const CommitCount = z.object({
  total: z.number(),
  repos: z.array(Repo),
}) satisfies Codec<T.CommitCount>;

const Unlock = z.object({
  id: z.string(),
  tier: z.number(),
  at: z.number(),
}) satisfies Codec<T.Unlock>;

const AgentTally = z.object({
  hired: z.number(),
  harvested: z.number(),
  failed: z.number(),
}) satisfies Codec<T.AgentTally>;

const ProgressTitle = z.object({
  id: z.string(),
  tier: z.number(),
}) satisfies Codec<T.ProgressTitle>;

export const Progress = z.object({
  coins: z.number(),
  streak: z.number(),
  bestStreak: z.number(),
  counts: z.record(z.string(), z.number()),
  unlocked: z.array(Unlock),
  title: z.exactOptional(ProgressTitle),
  agents: z.record(z.string(), AgentTally),
  multiplier: z.exactOptional(z.number()),
}) satisfies Codec<T.Progress>;

const ProgressNews = z.object({
  coins: z.exactOptional(z.number()),
  session: z.exactOptional(SessionId),
  unlocked: z.array(Unlock),
}) satisfies Codec<T.ProgressNews>;

const FarmLevel = z.object({
  level: z.number(),
  xp: z.number(),
  need: z.number(),
}) satisfies Codec<T.FarmLevel>;

const Crop = z.enum(T.CropValues) satisfies Codec<T.Crop>;

const BadgeTone = z.enum(T.BadgeToneValues) satisfies Codec<T.BadgeTone>;

const Badge = z.object({
  text: z.string(),
  tone: BadgeTone,
}) satisfies Codec<T.Badge>;

const PlotView = z.object({
  crop: Crop,
  badge: z.exactOptional(Badge),
}) satisfies Codec<T.PlotView>;

export const FarmView = z.object({
  level: FarmLevel,
  plots: z.record(z.string(), PlotView),
  plays: z.record(z.string(), SessionPlayView),
  achievements: z.array(AchievementStanding),
}) satisfies Codec<T.FarmView>;

const GameEffectReward = z.object({
  kind: z.literal("reward"),
  sessionId: z.exactOptional(SessionId),
  coins: z.number(),
  streak: z.number(),
}) satisfies Codec<T.GameEffectReward>;

const GameEffectPenalty = z.object({
  kind: z.literal("penalty"),
  sessionId: SessionId,
}) satisfies Codec<T.GameEffectPenalty>;

const GameEffectLevelUp = z.object({
  kind: z.literal("levelUp"),
  level: z.number(),
}) satisfies Codec<T.GameEffectLevelUp>;

const GameEffectAchievement = z.object({
  kind: z.literal("achievement"),
  achievement: z.string(),
  tier: z.number(),
  title: z.string(),
  reached: z.string(),
  detail: z.string(),
  coins: z.number(),
  oneOff: z.boolean(),
}) satisfies Codec<T.GameEffectAchievement>;

export const GameEffect = z.discriminatedUnion("kind", [
  GameEffectReward,
  GameEffectPenalty,
  GameEffectLevelUp,
  GameEffectAchievement,
]) satisfies Codec<T.GameEffect>;

const LedgerEntryHarvested = z.object({
  kind: z.literal("harvested"),
  at: z.number(),
  session: SessionId,
  agent: z.exactOptional(z.string()),
  repo: z.string(),
  runtime: z.string(),
  commits: z.number(),
  cny: z.exactOptional(z.number()),
  runs: z.number(),
}) satisfies Codec<T.LedgerEntryHarvested>;

const LedgerEntryFailed = z.object({
  kind: z.literal("failed"),
  at: z.number(),
  session: SessionId,
  agent: z.exactOptional(z.string()),
}) satisfies Codec<T.LedgerEntryFailed>;

const LedgerEntryConflicted = z.object({
  kind: z.literal("conflicted"),
  at: z.number(),
  session: SessionId,
}) satisfies Codec<T.LedgerEntryConflicted>;

const LedgerEntryTold = z.object({
  kind: z.literal("told"),
  at: z.number(),
  session: SessionId,
}) satisfies Codec<T.LedgerEntryTold>;

const LedgerEntryReviewed = z.object({
  kind: z.literal("reviewed"),
  at: z.number(),
  session: SessionId,
}) satisfies Codec<T.LedgerEntryReviewed>;

const LedgerEntryFamily = z.object({
  kind: z.literal("family"),
  at: z.number(),
  issue: IssueId,
  merged: z.number(),
  parallel: z.boolean(),
}) satisfies Codec<T.LedgerEntryFamily>;

const LedgerEntryHandoff = z.object({
  kind: z.literal("handoff"),
  at: z.number(),
  session: SessionId,
  to: z.string(),
}) satisfies Codec<T.LedgerEntryHandoff>;

const LedgerEntryCalled = z.object({
  kind: z.literal("called"),
  at: z.number(),
  session: SessionId,
}) satisfies Codec<T.LedgerEntryCalled>;

const LedgerEntryHired = z.object({
  kind: z.literal("hired"),
  at: z.number(),
  session: SessionId,
  agent: z.exactOptional(z.string()),
}) satisfies Codec<T.LedgerEntryHired>;

const LedgerEntryMomentKind = z.enum(T.LedgerEntryMomentKindValues) satisfies Codec<T.LedgerEntryMomentKind>;

const LedgerEntryMoment = z.object({
  kind: LedgerEntryMomentKind,
  at: z.number(),
}) satisfies Codec<T.LedgerEntryMoment>;

const LedgerEntryLevel = z.object({
  kind: z.literal("level"),
  at: z.number(),
  level: z.number(),
}) satisfies Codec<T.LedgerEntryLevel>;

const LedgerEntryTitled = z.object({
  kind: z.literal("titled"),
  at: z.number(),
  achievement: z.exactOptional(z.string()),
  tier: z.exactOptional(z.number()),
}) satisfies Codec<T.LedgerEntryTitled>;

export const LedgerEntry = z.discriminatedUnion("kind", [
  LedgerEntryHarvested,
  LedgerEntryFailed,
  LedgerEntryConflicted,
  LedgerEntryTold,
  LedgerEntryReviewed,
  LedgerEntryFamily,
  LedgerEntryHandoff,
  LedgerEntryCalled,
  LedgerEntryHired,
  LedgerEntryMoment,
  LedgerEntryLevel,
  LedgerEntryTitled,
]) satisfies Codec<T.LedgerEntry>;

export const ChooseTitleRequest = z.object({
  achievement: z.exactOptional(z.string()),
  tier: z.exactOptional(z.number()),
}) satisfies Codec<T.ChooseTitleRequest>;

export const FactProgressChanged = z.object({
  type: z.literal("progressChanged"),
  at: z.number(),
  progress: z.exactOptional(Progress),
  news: z.exactOptional(ProgressNews),
  commits: z.exactOptional(CommitCount),
  station: z.exactOptional(z.object({ id: SessionId, station: z.number() })),
}) satisfies Codec<T.FactProgressChanged>;
