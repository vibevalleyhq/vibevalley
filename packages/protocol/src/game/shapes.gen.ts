// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { IssueId, SessionId } from "../common/shapes.gen";
import type { Repo } from "../repo/shapes.gen";
import type { SessionAction } from "../session/shapes.gen";

export const AchievementCategoryValues = ["starter", "harvest", "craft", "thrift", "team", "secret"] as const;
export type AchievementCategory = (typeof AchievementCategoryValues)[number];

export type AchievementTier = { need: number, title: string, coins: number, reached: string, };

export type Achievement = { id: string, category: AchievementCategory, title: string, detail: string, unit?: string, wearable: boolean, tiers: Array<AchievementTier>, };

export type AchievementStanding = { id: string, tier: number, count: number, next?: number, };

export type AchievementList = { items: Array<Achievement>, standings: Array<AchievementStanding>, };

export type PlayAction = { at: number, action: SessionAction, label: string, };

export type PlayActionView = { at: number, action: SessionAction, label: string, actionText: string, };

export type SessionPlay = { station: number, toolsThisRun: number, counts: { [key in string]: number }, files: Array<string>, commands: Array<string>, runStartedAt?: number, history: Array<PlayAction>, };

export type SessionPlayView = { station: number, toolsThisRun: number, counts: { [key in string]: number }, files: Array<string>, commands: Array<string>, runStartedAt?: number, history: Array<PlayActionView>, };

export type CommitCount = { total: number, repos: Array<Repo>, };

export type Unlock = { id: string, tier: number, at: number, };

export type AgentTally = { hired: number, harvested: number, failed: number, };

export type ProgressTitle = { id: string, tier: number, };

export type Progress = { coins: number, streak: number, bestStreak: number, counts: { [key in string]: number }, unlocked: Array<Unlock>, title?: ProgressTitle, agents: { [key in string]: AgentTally }, multiplier?: number, };

export type ProgressNews = { coins?: number, session?: SessionId, unlocked: Array<Unlock>, };

export type FarmLevel = { level: number, xp: number, need: number, };

export const CropValues = ["empty", "seeded", "sprout", "leafy", "flowering", "wheat", "carrot", "withered", "weeds", "dry", "harvested", "locked"] as const;
export type Crop = (typeof CropValues)[number];

export const BadgeToneValues = ["ripe", "bug", "stuck", "rest", "wait"] as const;
export type BadgeTone = (typeof BadgeToneValues)[number];

export type Badge = { text: string, tone: BadgeTone, };

export type PlotView = { crop: Crop, badge?: Badge, };

export type FarmView = { level: FarmLevel,
/**
 * Each issue's plot, by the issue's id (`plotKeyOf`): a reopened issue's new session draws on the same one.
 */
plots: { [key in string]: PlotView },
/**
 * Each session's station and step history, by the session's id; the farm reads only this.
 */
plays: { [key in string]: SessionPlayView }, };

export type FarmFrame = { seq: number, view: FarmView, progress?: Progress, effects: Array<GameEffect>, };

export type GameEffectReward = { "kind": "reward",
/**
 * The session whose work paid; none for a reward of the farm as a whole.
 */
sessionId?: SessionId, coins: number, streak: number, };

export type GameEffectPenalty = { "kind": "penalty", sessionId: SessionId, };

export type GameEffectLevelUp = { "kind": "levelUp", level: number, };

export type GameEffectAchievement = { "kind": "achievement", achievement: string, tier: number, title: string, reached: string, detail: string, coins: number, oneOff: boolean, };

/**
 * Told apart by `kind`.
 */
export type GameEffect = GameEffectReward | GameEffectPenalty | GameEffectLevelUp | GameEffectAchievement;

export type LedgerEntryHarvested = { "kind": "harvested", at: number, session: SessionId, agent?: string, repo: string, runtime: string, commits: number, cny?: number, runs: number, };

export type LedgerEntryFailed = { "kind": "failed", at: number, session: SessionId, agent?: string, };

export type LedgerEntryConflicted = { "kind": "conflicted", at: number, session: SessionId, };

export type LedgerEntryTold = { "kind": "told", at: number, session: SessionId, };

export type LedgerEntryReviewed = { "kind": "reviewed", at: number, session: SessionId, };

export type LedgerEntryFamily = { "kind": "family", at: number, issue: IssueId, merged: number, parallel: boolean, };

export type LedgerEntryHandoff = { "kind": "handoff", at: number, session: SessionId, to: string, };

export type LedgerEntryCalled = { "kind": "called", at: number, session: SessionId, };

export type LedgerEntryHired = { "kind": "hired", at: number, session: SessionId, agent?: string, };

export const LedgerEntryMomentKindValues = ["opened", "split", "voice", "busy6"] as const;
export type LedgerEntryMomentKind = (typeof LedgerEntryMomentKindValues)[number];

export type LedgerEntryMoment = { "kind": "opened" | "split" | "voice" | "busy6", at: number, };

export type LedgerEntryLevel = { "kind": "level", at: number, level: number, };

export type LedgerEntryTitled = { "kind": "titled", at: number, achievement?: string, tier?: number, };

/**
 * Told apart by `kind`.
 */
export type LedgerEntry = LedgerEntryHarvested | LedgerEntryFailed | LedgerEntryConflicted | LedgerEntryTold | LedgerEntryReviewed | LedgerEntryFamily | LedgerEntryHandoff | LedgerEntryCalled | LedgerEntryHired | LedgerEntryMoment | LedgerEntryLevel | LedgerEntryTitled;

export type ChooseTitleRequest = { achievement?: string, tier?: number, };

export type FactProgressChangedStation = { id: SessionId, station: number, };

export type FactProgressChanged = { "type": "progressChanged", at: number, progress?: Progress, news?: ProgressNews, commits?: CommitCount, station?: FactProgressChangedStation, };
