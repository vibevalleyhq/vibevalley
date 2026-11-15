import type { SessionId } from "../common/shapes";
import type { Repo } from "../repo/shapes";
import type { Doing } from "../session/shapes";

export const AchievementCategoryValues = ["starter", "harvest", "craft", "thrift", "team", "secret"] as const;
export type AchievementCategory = (typeof AchievementCategoryValues)[number];

export interface Achievement {
  id: string;
  category: AchievementCategory;
  title: string;
  detail: string;
  unit?: string;
  wearable: boolean;
  tiers: AchievementTier[];
}

export interface AchievementTier {
  need: number;
  title: string;
  coins: number;
  reached: string;
}

export interface AchievementStanding {
  id: string;
  tier: number;
  count: number;
  next?: number;
}

export interface PlayActionView extends Doing {
  at: number;
  actionText: string;
}

export interface SessionPlayView {
  station: number;
  history: PlayActionView[];
  toolsThisRun: number;
  counts: Record<string, number>;
  files: string[];
  commands: string[];
  runStartedAt?: number;
}

export interface CommitCount {
  total: number;
  repos: Repo[];
}

export interface Unlock {
  id: string;
  tier: number;
  at: number;
}

export interface AgentTally {
  hired: number;
  harvested: number;
  failed: number;
}

export interface Progress {
  coins: number;
  streak: number;
  bestStreak: number;
  counts: Record<string, number>;
  unlocked: Unlock[];
  title?: ProgressTitle;
  agents: Record<string, AgentTally>;
  multiplier?: number;
}

export interface ProgressNews {
  coins?: number;
  session?: SessionId;
  unlocked: Unlock[];
}

export interface FarmLevel {
  level: number;
  xp: number;
  need: number;
}

export const CropValues = ["empty", "seeded", "sprout", "leafy", "flowering", "wheat", "carrot", "withered", "weeds", "dry", "harvested", "locked"] as const;
export type Crop = (typeof CropValues)[number];

export const BadgeToneValues = ["ripe", "bug", "stuck", "rest", "wait"] as const;
export type BadgeTone = (typeof BadgeToneValues)[number];

export interface PlotView {
  crop: Crop;
  badge?: Badge;
}

export interface FarmView {
  level: FarmLevel;
  /** Each issue's plot, by the issue's id (`plotKeyOf`): a reopened issue's new session draws on the same one. */
  plots: Record<string, PlotView>;
  /** Each session's station and step history, by the session's id; the farm reads only this. */
  plays: Record<string, SessionPlayView>;
  achievements: AchievementStanding[];
}

/** Told apart by `kind`. */
export type GameEffect = GameEffectReward | GameEffectPenalty | GameEffectLevelUp | GameEffectAchievement;

export interface ProgressTitle {
  id: string;
  tier: number;
}

export interface Badge {
  text: string;
  tone: BadgeTone;
}

export interface GameEffectReward {
  kind: "reward";
  /** The session whose work paid; none for a reward of the farm as a whole. */
  sessionId?: SessionId;
  coins: number;
  streak: number;
}

export interface GameEffectPenalty {
  kind: "penalty";
  sessionId: SessionId;
}

export interface GameEffectLevelUp {
  kind: "levelUp";
  level: number;
}

export interface GameEffectAchievement {
  kind: "achievement";
  achievement: string;
  tier: number;
  title: string;
  reached: string;
  detail: string;
  coins: number;
  oneOff: boolean;
}

export interface ChooseTitleRequest {
  achievement?: string;
  tier?: number;
}

export interface FactProgressChanged {
  type: "progressChanged";
  at: number;
  progress?: Progress;
  news?: ProgressNews;
  commits?: CommitCount;
  station?: { readonly id: SessionId; readonly station: number };
}
