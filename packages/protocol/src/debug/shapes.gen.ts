// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { EventTokens, SessionEvent } from "../session/shapes.gen";

export const DebugTimelineLaneValues = ["core_apply", "bridge_rpc", "oar_wire", "gpui_frame"] as const;
export type DebugTimelineLane = (typeof DebugTimelineLaneValues)[number];

export type DebugTimelineEvent = { id: number, time: number, lane: DebugTimelineLane, kind: string, traceId?: number, durationUs?: number, summary: string, detail?: unknown, slow?: boolean, };

export type DebugTimelineQuery = { lane?: DebugTimelineLane, afterId?: number, limit?: number, search?: string, };

export type DebugTimelinePage = { events: Array<DebugTimelineEvent>, latestId: number, dropped: number, };

export const DebugTrajectoryKindValues = ["issue_session", "workspace_chat", "orchestrator"] as const;
export type DebugTrajectoryKind = (typeof DebugTrajectoryKindValues)[number];

export type DebugTrajectorySummary = { id: string, kind: DebugTrajectoryKind, title: string, runtime: string, status: string, updatedAt: number, eventCount: number, hasVoyageRecord: boolean, hasSilentError: boolean, tokens?: EventTokens, };

export type DebugTrajectoryRawEntry = { seq: number, time: number, kind: string, frameType?: string, agentPath: Array<string>, traceId?: number, summary: string, payload?: string, originalBytes: number, truncated: boolean, };

export type DebugTrajectoryTurn = { index: number, prompt?: string, startedAt: number, endedAt?: number, durationMs?: number, events: Array<SessionEvent>, rawEntries: Array<DebugTrajectoryRawEntry>, tokens?: EventTokens, silentErrors: Array<string>, traceIds: Array<number>, };

export type DebugTrajectorySubagentNode = { id: string, parentId?: string, path: string, label: string, agentName?: string, status?: string, turnCount: number, eventCount: number, rawCount: number, startedAt?: number, endedAt?: number, traceIds: Array<number>, };

export type DebugTrajectoryDetail = { summary: DebugTrajectorySummary, systemPrompt?: string, turns: Array<DebugTrajectoryTurn>, subagentPaths: Array<string>, subagentNodes: Array<DebugTrajectorySubagentNode>, voyageRecordCount: number, };

export type DebugTrajectoryGetRequest = { id: string, kind?: DebugTrajectoryKind, };

export type DebugTrajectoryExportRequest = { id: string, kind?: DebugTrajectoryKind, outDir?: string, };

export type DebugTrajectoryExportResult = { dir: string, replaySpecPath: string, conversationId: string, sourceKind: string, entriesExported: number, tasksExported: number, conversationsExported: number, inspectCmd: string, replayCmd: string, };

export type DebugRuntimeSummary = { id: string, name: string, installed: boolean, ready: boolean, version?: string, };

export type DebugOverview = { channel: string, version: string, loopbackUrl?: string, homePath: string, workRoot: string, dbPath: string, bundleMode?: string, bootMs?: number, activeSessions: number, activeClients: number, activeSubscriptions: number, latestSeq: number, lastFrameMs?: number, runtimes: Array<DebugRuntimeSummary>, };

export type DebugGraphClient = { id: string, kind: string, label: string, watches: Array<string>, subscriptions: Array<string>, };

export type DebugGraphSession = { sessionId: string, issueId?: number, title: string, runtime: string, status: string, worktree?: string, kind: DebugTrajectoryKind, };

export type DebugGraph = { clients: Array<DebugGraphClient>, sessions: Array<DebugGraphSession>, };

export type DebugCacheStat = { name: string, entries: number, detail?: string, };

export type DebugCollabClock = { peerId: string, counter: number, };

export type DebugCollabPresence = { id: string, name: string, color?: string, kind: string, status?: string, nodeId?: string, path?: string, offset?: number, endOffset?: number, sessionId?: string, updatedAt: number, };

export type DebugCollabNoteState = { noteId: string, title: string, noteType: string, seq: number, snapshotBytes: number, frontiers: string, frontierIds: Array<DebugCollabClock>, versionVector: string, vvEntries: Array<DebugCollabClock>, ephemeralTtlMs: number, presenceCount: number, presence: Array<DebugCollabPresence>, updatedAt: number, };

export type DebugStateCounts = { issues: number, sessions: number, channels: number, agents: number, repos: number, notes: number, inbox: number, mediaJobs: number, };

export type DebugStateCache = { seq: number, sliceSeqs: { [key in string]: number }, sliceWatchers: { [key in string]: number }, counts: DebugStateCounts, caches: Array<DebugCacheStat>, collab: Array<DebugCollabNoteState>, };

export type DebugOverrideConfig = { rpcDelayMs: number, sliceDelayMs: number, targetFilter?: string, disconnectTopic?: string, };

export type DebugBundleResult = { path: string, sizeBytes: number, files: Array<string>, redactedCount: number, };

export type DebugSnapshot = { overview: DebugOverview, routes: unknown, overrides: DebugOverrideConfig, graph: DebugGraph, stateCache: DebugStateCache, recentTimeline: Array<DebugTimelineEvent>, };
