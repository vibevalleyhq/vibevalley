// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { ChannelSummary, Chat, FactChannelChanged, FactChannelRemoved, FactMessageChanged, FactUserMentionsChanged } from "../channel/shapes.gen";
import type { SessionId } from "../common/shapes.gen";
import type { ConnectorStatus, FactConnectorChanged } from "../connector/shapes.gen";
import type { Cron, CronView, FactCronChanged, FactCronRemoved } from "../cron/shapes.gen";
import type { CommitCount, FactProgressChanged, FarmView, GameEffect, Progress, SessionPlay } from "../game/shapes.gen";
import type { InboxItem } from "../inbox/shapes.gen";
import type { BoardSummary, FactIssueChanged, FactIssueRemoved, FactSessionReported, Issue } from "../issue/shapes.gen";
import type { FactMediaChanged, MediaJob, MediaSummary } from "../media/shapes.gen";
import type { RuntimeInfo } from "../runtime/shapes.gen";
import type { FactMachineChanged, FactSessionChanged, FactSessionLeft, FactSessionPhaseChanged, FactSessionSubagentsChanged, FactSessionToolChanged, FactSessionToolsReset, Machine, Session, SessionEvent, SessionView } from "../session/shapes.gen";
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
 * The farm's pixel-only station and step history, by session; no business rule reads it.
 */
plays?: { [key in string]: SessionPlay }, };

export type SpaceView = { call: CallState, callReason: string, media?: Array<MediaJob>, chat?: Chat, commits?: CommitCount, progress?: Progress, issues: Array<Issue>, connectors: Array<ConnectorStatus>, machines: Array<Machine>, sessions: Array<SessionView>, crons: Array<CronView>, boardSummary?: BoardSummary, mediaSummary?: MediaSummary, channelSummary?: ChannelSummary, };

export const NoticeLevelValues = ["info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevelValues)[number];

export type StateFrame = {
/**
 * Goes up by one with every commit the core folds (Core.apply that changed the state): this frame shows every fold up to it.
 */
seq: number, state: SpaceView, inbox: Array<InboxItem>, view: FarmView, effects: Array<GameEffect>, };

export type Health = { ok: boolean, version: string, };

/**
 * Told apart by `type`.
 */
export type Fact = FactCallChanged | FactSessionToolChanged | FactSessionToolsReset | FactSessionSubagentsChanged | FactSessionPhaseChanged | FactMessageChanged | FactChannelChanged | FactUserMentionsChanged | FactSessionChanged | FactSessionReported | FactSessionLeft | FactProgressChanged | FactIssueChanged | FactIssueRemoved | FactChannelRemoved | FactCronChanged | FactCronRemoved | FactConnectorChanged | FactMachineChanged | FactMediaChanged;

export type ServerEventSnapshot = { "type": "snapshot", at: number, state: SpaceState, };

export type LiveEventSession = { "type": "event", at: number, id: SessionId, activity: SessionEvent, };

export type LiveEventNotice = { "type": "notice", at: number, level: NoticeLevel, text: string, };

export type LiveEventRuntime = { "type": "runtime", at: number, info: RuntimeInfo, };

/**
 * Told apart by `type`.
 */
export type LiveEvent = LiveEventSession | LiveEventNotice | LiveEventRuntime;

/**
 * Told apart by `type`.
 */
export type ServerEvent = FactCallChanged | FactSessionToolChanged | FactSessionToolsReset | FactSessionSubagentsChanged | FactSessionPhaseChanged | FactMessageChanged | FactChannelChanged | FactUserMentionsChanged | FactSessionChanged | FactSessionReported | FactSessionLeft | FactProgressChanged | FactIssueChanged | FactIssueRemoved | FactChannelRemoved | FactCronChanged | FactCronRemoved | FactConnectorChanged | FactMachineChanged | FactMediaChanged | ServerEventSnapshot | LiveEventSession | LiveEventNotice | LiveEventRuntime;

export type ChannelFollowPayload = { id: string, after: number, };

export type ChannelReportsPayload = { after?: string, };

export type ArtifactFollowPayload = { id: string, after: number, };

export type ArtifactSuggestionFollowPayload = { id: string, };
