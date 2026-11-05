import type { SessionId } from "../common/shapes";
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

export interface PlayAction extends Doing {
  at: number;
}

export interface PlayActionView extends PlayAction {
  actionText: string;
}

export interface SessionPlay {
  station: number;
  history: PlayAction[];
  toolsThisRun: number;
  counts: Record<string, number>;
  files: string[];
  commands: string[];
  runStartedAt?: number;
}

export interface SessionPlayView extends Omit<SessionPlay, "history"> {
  history: PlayActionView[];
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

/** Told apart by `kind`. */
export type LedgerEntry =
  | LedgerEntryHarvested
  | LedgerEntryFailed
  | LedgerEntryConflicted
  | LedgerEntryTold
  | LedgerEntryReviewed
  | LedgerEntryFamily
  | LedgerEntryHandoff
  | LedgerEntryCalled
  | LedgerEntryHired
  | LedgerEntryMoment
  | LedgerEntryLevel
  | LedgerEntryTitled;

export interface Repo {
  path: string;
  commits: number;
}

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

export interface LedgerEntryHarvested {
  kind: "harvested";
  at: number;
  session: SessionId;
  agent?: string;
  project: string;
  runtime: string;
  commits: number;
  cny?: number;
  runs: number;
}

export interface LedgerEntryFailed {
  kind: "failed";
  at: number;
  session: SessionId;
  agent?: string;
}

export interface LedgerEntryConflicted {
  kind: "conflicted";
  at: number;
  session: SessionId;
}

export interface LedgerEntryTold {
  kind: "told";
  at: number;
  session: SessionId;
}

export interface LedgerEntryReviewed {
  kind: "reviewed";
  at: number;
  session: SessionId;
}

export interface LedgerEntryFamily {
  kind: "family";
  at: number;
  issue: string;
  merged: number;
  parallel: boolean;
}

export interface LedgerEntryHandoff {
  kind: "handoff";
  at: number;
  session: SessionId;
  to: string;
}

export interface LedgerEntryCalled {
  kind: "called";
  at: number;
  session: SessionId;
}

export interface LedgerEntryHired {
  kind: "hired";
  at: number;
  session: SessionId;
  agent?: string;
}

export const LedgerEntryMomentKindValues = ["opened", "split", "voice", "busy6"] as const;
export type LedgerEntryMomentKind = (typeof LedgerEntryMomentKindValues)[number];

export interface LedgerEntryMoment {
  kind: LedgerEntryMomentKind;
  at: number;
}

export interface LedgerEntryLevel {
  kind: "level";
  at: number;
  level: number;
}

export interface LedgerEntryTitled {
  kind: "titled";
  at: number;
  achievement?: string;
  tier?: number;
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
