// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ChannelSummary, Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactUserMentionsChanged } from "../channel/shapes.gen";
import type { IssueId, SessionId } from "../common/shapes.gen";
import type { ConnectorStatus, FactConnectorChanged } from "../connector/shapes.gen";
import type { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/shapes.gen";
import type { CommitCount, FactProgressChanged, FarmFrame, Progress, SessionPlay } from "../game/shapes.gen";
import type { FactRuntimeInboxChanged, InboxItem } from "../inbox/shapes.gen";
import type { BoardSummary, FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue, IssueStatus } from "../issue/shapes.gen";
import type { FactMediaChanged, MediaJob, MediaSummary } from "../media/shapes.gen";
import type { RepoHealth } from "../repo/shapes.gen";
import type { RuntimeInfo } from "../runtime/shapes.gen";
import type { FactMachineChanged, FactMachineRemoved, FactSessionChanged, FactSessionLeft, FactSessionPhaseChanged, FactSessionSubagentsChanged, FactSessionToolChanged, FactSessionToolsReset, Machine, Session, SessionEvent, SessionView } from "../session/shapes.gen";
import type { CallState, FactCallChanged } from "../voice/shapes.gen";

export type SpaceState = { call: CallState, callReason: string, media?: Array<MediaJob>, chat?: Chat, commits?: CommitCount, progress?: Progress, issues: Array<Issue>,
/**
 * Each chat app's status, as the connectors say it whenever it changes; their home is the connectors, not state.json.
 */
connectors: Array<ConnectorStatus>,
/**
 * The machines helpers work on, as the machine module says them.
 */
machines: Array<Machine>,
/**
 * Each orchestrator not at rest, by its profile id, as its last orchestrator fact says; one not here is idle.
 */
sessions: Array<Session>, crons: Array<Cron>,
/**
 * The farm scene's station and step history, by session; no business rule reads it.
 */
plays?: { [key in string]: SessionPlay },
/**
 * Durable runtime inbox alerts projected into `InboxSlice` via `Fact::RuntimeInboxChanged`.
 */
runtimeInboxItems?: Array<InboxItem>, };

export const SliceKindValues = ["board", "sessions", "collab", "inbox", "ops", "farm"] as const;
export type SliceKind = (typeof SliceKindValues)[number];

export const NoticeLevelValues = ["info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevelValues)[number];

export type BoardSlice = { seq: number, issues: Array<Issue>, boardSummary?: BoardSummary, commits?: CommitCount, repoHealth?: Array<RepoHealth>, };

export type SessionsSlice = { seq: number, sessions: Array<SessionView>, machines: Array<Machine>, };

export type CollabSlice = { seq: number, chat?: Chat, channelSummary?: ChannelSummary, connectors: Array<ConnectorStatus>, };

export type InboxSlice = { seq: number, items: Array<InboxItem>, call: CallState, callReason: string, };

export type OpsSlice = { seq: number, crons: Array<CronView>, media?: Array<MediaJob>, mediaSummary?: MediaSummary, };

/**
 * Offline snapshot, scenario, and fixture bundle; never served as an HTTP endpoint.
 */
export type SliceBundle = { seq: number, board: BoardSlice, sessions: SessionsSlice, collab: CollabSlice, inbox: InboxSlice, ops: OpsSlice, farm: FarmFrame, };

export type Health = { ok: boolean, version: string, };

/**
 * Told apart by `type`.
 */
export type Fact = FactCallChanged | FactSessionToolChanged | FactSessionToolsReset | FactSessionSubagentsChanged | FactSessionPhaseChanged | FactMessageChanged | FactChannelChanged | FactUserMentionsChanged | FactSessionChanged | FactSessionReported | FactSessionLeft | FactProgressChanged | FactIssueChanged | FactIssueRemoved | FactChannelRemoved | FactCronChanged | FactCronRemoved | FactConnectorChanged | FactMachineChanged | FactMachineRemoved | FactMediaChanged | FactRuntimeInboxChanged;

export type LiveEventSession = { "type": "event", at: number, id: SessionId, activity: SessionEvent, };

export type LiveEventNotice = { "type": "notice", at: number, level: NoticeLevel, text: string, };

export type LiveEventRuntime = { "type": "runtime", at: number, info: RuntimeInfo, };

/**
 * Told apart by `type`.
 */
export type LiveEvent = LiveEventSession | LiveEventNotice | LiveEventRuntime;

export type ChannelFollowPayload = { id: string, after: number, };

export type ChannelReportsPayload = { after?: string, };

export const RetroWindowValues = ["7d", "14d", "30d", "all"] as const;
export type RetroWindow = (typeof RetroWindowValues)[number];

export type IssueRetroGetInput = { window?: RetroWindow, };

export type RetroDurationStats = { sampleCount: number, medianMs?: number, p90Ms?: number, };

export type RetroOverdueItem = { id: IssueId, number: number, title: string, status: IssueStatus, repo?: string, agent?: string, dueAt: number, closedAt?: number, overdueMs: number, };

export type RetroReworkItem = { id: IssueId, number: number, title: string, status: IssueStatus, repo?: string, agent?: string, findingsCount: number, unresolvedCount: number, };

export type RetroBreakdownBucket = { key: string, totalCount: number, completedCount: number, canceledCount: number, overdueCount: number, reworkCount: number, medianCycleMs?: number, };

export type IssueRetroReport = { window: RetroWindow, generatedAt: number, windowStartAt?: number, totalIssues: number, openCount: number, completedCount: number, canceledCount: number, completionRatePct?: number, cycleTime: RetroDurationStats, reviewWait: RetroDurationStats, withDueCount: number, withoutDueCount: number, onTimeCount: number, overdueCount: number, upcomingDueCount: number, onTimeRatePct?: number, overdueRatePct?: number, reworkIssueCount: number, totalFindingsCount: number, unresolvedFindingsCount: number, reworkRatePct?: number, overdueItems: Array<RetroOverdueItem>, reworkItems: Array<RetroReworkItem>, byRepo: Array<RetroBreakdownBucket>, byTag: Array<RetroBreakdownBucket>, byAgent: Array<RetroBreakdownBucket>, };
