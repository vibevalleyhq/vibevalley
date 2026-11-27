// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { IssueId, SessionId } from "../common/shapes.gen";
import type { IssueTemplate, Repo } from "../repo/shapes.gen";
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

export const ShopItemKindValues = ["decoration", "template"] as const;
export type ShopItemKind = (typeof ShopItemKindValues)[number];

export type YardDecorationPlacement = { asset: string, x: number, z: number, yawDeg: number, scale: number, };

export type YardDecoration = { id: string, asset: string, title: string, x: number, z: number, yawDeg: number, scale: number, };

export type ShopItem = { id: string, kind: ShopItemKind, title: string, detail: string, price: number, owned: boolean, decoration?: YardDecorationPlacement, template?: IssueTemplate, };

export const DailyTaskKindValues = ["tests_passed", "reviews_completed", "clean_harvest", "milestone_done"] as const;
export type DailyTaskKind = (typeof DailyTaskKindValues)[number];

export type DailyTask = { id: string, kind: DailyTaskKind, title: string, detail: string, progress: number, target: number, rewardCoins: number, completed: boolean, settled: boolean, settledAt?: number, };

export type DailyTaskBoard = { day: string, tasks: Array<DailyTask>, settledCoinsToday: number, };

export type FarmShopView = { coins: number, items: Array<ShopItem>, daily: DailyTaskBoard, };

export type ShopPurchaseRequest = { id: string, };

export type Progress = { coins: number, streak: number, bestStreak: number, counts: { [key in string]: number }, unlocked: Array<Unlock>, title?: ProgressTitle, agents: { [key in string]: AgentTally }, multiplier?: number, purchased?: Array<string>, daily?: DailyTaskBoard, };

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
plays: { [key in string]: SessionPlayView },
/**
 * Unlocked yard decorations rendered in the 3D diorama scene.
 */
decorations?: Array<YardDecoration>, };

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

export type LedgerEntryPurchased = { "kind": "purchased", at: number, itemId: string, itemKind: ShopItemKind, price: number, };

export type LedgerEntryDailySettled = { "kind": "dailySettled", at: number, day: string, taskId: string, taskKind: DailyTaskKind, coins: number, };

export type LedgerEntryCheckPassed = { "kind": "checkPassed", at: number, key: string, };

export type LedgerEntryReviewCompleted = { "kind": "reviewCompleted", at: number, key: string, passed: boolean, };

export type LedgerEntryDelivered = { "kind": "delivered", at: number, issue: IssueId, clean: boolean, };

/**
 * Told apart by `kind`.
 */
export type LedgerEntry = LedgerEntryHarvested | LedgerEntryFailed | LedgerEntryConflicted | LedgerEntryTold | LedgerEntryReviewed | LedgerEntryFamily | LedgerEntryHandoff | LedgerEntryCalled | LedgerEntryHired | LedgerEntryMoment | LedgerEntryLevel | LedgerEntryTitled | LedgerEntryPurchased | LedgerEntryDailySettled | LedgerEntryCheckPassed | LedgerEntryReviewCompleted | LedgerEntryDelivered;

export type ChooseTitleRequest = { achievement?: string, tier?: number, };

export type FactProgressChangedStation = { id: SessionId, station: number, };

export type FactProgressChanged = { "type": "progressChanged", at: number, progress?: Progress, news?: ProgressNews, commits?: CommitCount, station?: FactProgressChangedStation, };
