import { Schema } from "effect";

import type { Codec } from "../codec";
import { SessionId } from "../common/schema";
import { doingFields } from "../session/schema";
import * as T from "../shapes";

export const AchievementCategory: Codec<T.AchievementCategory> = Schema.Literals(T.AchievementCategoryValues);

export const AchievementTier: Codec<T.AchievementTier> = Schema.Struct({
  need: Schema.Finite,
  title: Schema.String,
  coins: Schema.Finite,
  reached: Schema.String,
});

export const Achievement: Codec<T.Achievement> = Schema.Struct({
  id: Schema.String,
  category: AchievementCategory,
  title: Schema.String,
  detail: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  wearable: Schema.Boolean,
  tiers: Schema.mutable(Schema.Array(AchievementTier)),
});

export const AchievementStanding: Codec<T.AchievementStanding> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Finite,
  count: Schema.Finite,
  next: Schema.optionalKey(Schema.Finite),
});

export const PlayAction: Codec<T.PlayAction> = Schema.Struct({ at: Schema.Finite, ...doingFields });

export const PlayActionView: Codec<T.PlayActionView> = Schema.Struct({ at: Schema.Finite, ...doingFields, actionText: Schema.String });

const playFields = {
  station: Schema.Finite,
  toolsThisRun: Schema.Finite,
  counts: Schema.Record(Schema.String, Schema.Finite),
  files: Schema.mutable(Schema.Array(Schema.String)),
  commands: Schema.mutable(Schema.Array(Schema.String)),
  runStartedAt: Schema.optionalKey(Schema.Finite),
};

export const SessionPlay: Codec<T.SessionPlay> = Schema.Struct({ ...playFields, history: Schema.mutable(Schema.Array(PlayAction)) });

export const SessionPlayView: Codec<T.SessionPlayView> = Schema.Struct({ ...playFields, history: Schema.mutable(Schema.Array(PlayActionView)) });

export const Repo: Codec<T.Repo> = Schema.Struct({
  path: Schema.String,
  commits: Schema.Finite,
});

export const CommitCount: Codec<T.CommitCount> = Schema.Struct({
  total: Schema.Finite,
  repos: Schema.mutable(Schema.Array(Repo)),
});

export const Unlock: Codec<T.Unlock> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Finite,
  at: Schema.Finite,
});

export const AgentTally: Codec<T.AgentTally> = Schema.Struct({
  hired: Schema.Finite,
  harvested: Schema.Finite,
  failed: Schema.Finite,
});

export const ProgressTitle: Codec<T.ProgressTitle> = Schema.Struct({
  id: Schema.String,
  tier: Schema.Finite,
});

export const Progress: Codec<T.Progress> = Schema.Struct({
  coins: Schema.Finite,
  streak: Schema.Finite,
  bestStreak: Schema.Finite,
  counts: Schema.Record(Schema.String, Schema.Finite),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
  title: Schema.optionalKey(ProgressTitle),
  agents: Schema.Record(Schema.String, AgentTally),
  multiplier: Schema.optionalKey(Schema.Finite),
});

export const ProgressNews: Codec<T.ProgressNews> = Schema.Struct({
  coins: Schema.optionalKey(Schema.Finite),
  session: Schema.optionalKey(SessionId),
  unlocked: Schema.mutable(Schema.Array(Unlock)),
});

export const FarmLevel: Codec<T.FarmLevel> = Schema.Struct({
  level: Schema.Finite,
  xp: Schema.Finite,
  need: Schema.Finite,
});

export const Crop: Codec<T.Crop> = Schema.Literals(T.CropValues);

export const BadgeTone: Codec<T.BadgeTone> = Schema.Literals(T.BadgeToneValues);

export const Badge: Codec<T.Badge> = Schema.Struct({
  text: Schema.String,
  tone: BadgeTone,
});

export const PlotView: Codec<T.PlotView> = Schema.Struct({
  crop: Crop,
  badge: Schema.optionalKey(Badge),
});

export const FarmView: Codec<T.FarmView> = Schema.Struct({
  level: FarmLevel,
  plots: Schema.Record(Schema.String, PlotView),
  plays: Schema.Record(Schema.String, SessionPlayView),
  achievements: Schema.mutable(Schema.Array(AchievementStanding)),
});

export const GameEffectReward: Codec<T.GameEffectReward> = Schema.Struct({
  kind: Schema.Literal("reward"),
  sessionId: Schema.optionalKey(SessionId),
  coins: Schema.Finite,
  streak: Schema.Finite,
});

export const GameEffectPenalty: Codec<T.GameEffectPenalty> = Schema.Struct({
  kind: Schema.Literal("penalty"),
  sessionId: SessionId,
});

export const GameEffectLevelUp: Codec<T.GameEffectLevelUp> = Schema.Struct({
  kind: Schema.Literal("levelUp"),
  level: Schema.Finite,
});

export const GameEffectAchievement: Codec<T.GameEffectAchievement> = Schema.Struct({
  kind: Schema.Literal("achievement"),
  achievement: Schema.String,
  tier: Schema.Finite,
  title: Schema.String,
  reached: Schema.String,
  detail: Schema.String,
  coins: Schema.Finite,
  oneOff: Schema.Boolean,
});

export const GameEffect: Codec<T.GameEffect> = Schema.Union([GameEffectReward, GameEffectPenalty, GameEffectLevelUp, GameEffectAchievement]);

export const LedgerEntryHarvested: Codec<T.LedgerEntryHarvested> = Schema.Struct({
  kind: Schema.Literal("harvested"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
  repo: Schema.String,
  runtime: Schema.String,
  commits: Schema.Finite,
  cny: Schema.optionalKey(Schema.Finite),
  runs: Schema.Finite,
});

export const LedgerEntryFailed: Codec<T.LedgerEntryFailed> = Schema.Struct({
  kind: Schema.Literal("failed"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryConflicted: Codec<T.LedgerEntryConflicted> = Schema.Struct({
  kind: Schema.Literal("conflicted"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryTold: Codec<T.LedgerEntryTold> = Schema.Struct({
  kind: Schema.Literal("told"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryReviewed: Codec<T.LedgerEntryReviewed> = Schema.Struct({
  kind: Schema.Literal("reviewed"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryFamily: Codec<T.LedgerEntryFamily> = Schema.Struct({
  kind: Schema.Literal("family"),
  at: Schema.Finite,
  issue: Schema.String,
  merged: Schema.Finite,
  parallel: Schema.Boolean,
});

export const LedgerEntryHandoff: Codec<T.LedgerEntryHandoff> = Schema.Struct({
  kind: Schema.Literal("handoff"),
  at: Schema.Finite,
  session: SessionId,
  to: Schema.String,
});

export const LedgerEntryCalled: Codec<T.LedgerEntryCalled> = Schema.Struct({
  kind: Schema.Literal("called"),
  at: Schema.Finite,
  session: SessionId,
});

export const LedgerEntryHired: Codec<T.LedgerEntryHired> = Schema.Struct({
  kind: Schema.Literal("hired"),
  at: Schema.Finite,
  session: SessionId,
  agent: Schema.optionalKey(Schema.String),
});

export const LedgerEntryMomentKind: Codec<T.LedgerEntryMomentKind> = Schema.Literals(T.LedgerEntryMomentKindValues);

export const LedgerEntryMoment: Codec<T.LedgerEntryMoment> = Schema.Struct({
  kind: LedgerEntryMomentKind,
  at: Schema.Finite,
});

export const LedgerEntryLevel: Codec<T.LedgerEntryLevel> = Schema.Struct({
  kind: Schema.Literal("level"),
  at: Schema.Finite,
  level: Schema.Finite,
});

export const LedgerEntryTitled: Codec<T.LedgerEntryTitled> = Schema.Struct({
  kind: Schema.Literal("titled"),
  at: Schema.Finite,
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Finite),
});

export const LedgerEntry: Codec<T.LedgerEntry> = Schema.Union([
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
]);

export const ChooseTitleRequest: Codec<T.ChooseTitleRequest> = Schema.Struct({
  achievement: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Finite),
});

export const FactProgressChanged: Codec<T.FactProgressChanged> = Schema.Struct({
  type: Schema.Literal("progressChanged"),
  at: Schema.Finite,
  progress: Schema.optionalKey(Progress),
  news: Schema.optionalKey(ProgressNews),
  commits: Schema.optionalKey(CommitCount),
  station: Schema.optionalKey(Schema.Struct({ id: SessionId, station: Schema.Finite })),
});
