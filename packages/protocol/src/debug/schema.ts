import { z } from "zod";

import type { Codec } from "../codec";
import { EventTokens, SessionEvent } from "../session/schema";
import * as T from "./shapes.gen";

export const DebugTimelineLane = z.enum(T.DebugTimelineLaneValues) satisfies Codec<T.DebugTimelineLane>;

export const DebugTimelineEvent = z.object({
  id: z.number(),
  time: z.number(),
  lane: DebugTimelineLane,
  kind: z.string(),
  traceId: z.exactOptional(z.number()),
  durationUs: z.exactOptional(z.number()),
  summary: z.string(),
  detail: z.exactOptional(z.unknown()),
  slow: z.exactOptional(z.boolean()),
}) satisfies Codec<T.DebugTimelineEvent>;

export const DebugTimelineQuery = z.object({
  lane: z.exactOptional(DebugTimelineLane),
  afterId: z.exactOptional(z.number()),
  limit: z.exactOptional(z.number()),
  search: z.exactOptional(z.string()),
}) satisfies Codec<T.DebugTimelineQuery>;

export const DebugTimelinePage = z.object({
  events: z.array(DebugTimelineEvent),
  latestId: z.number(),
  dropped: z.number(),
}) satisfies Codec<T.DebugTimelinePage>;

export const DebugTrajectoryKind = z.enum(T.DebugTrajectoryKindValues) satisfies Codec<T.DebugTrajectoryKind>;

export const DebugTrajectorySummary = z.object({
  id: z.string(),
  kind: DebugTrajectoryKind,
  title: z.string(),
  runtime: z.string(),
  status: z.string(),
  updatedAt: z.number(),
  eventCount: z.number(),
  hasVoyageRecord: z.boolean(),
  hasSilentError: z.boolean(),
  tokens: z.exactOptional(EventTokens),
}) satisfies Codec<T.DebugTrajectorySummary>;

export const DebugTrajectoryRawEntry = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.string(),
  frameType: z.exactOptional(z.string()),
  agentPath: z.array(z.string()),
  traceId: z.exactOptional(z.number()),
  summary: z.string(),
  payload: z.exactOptional(z.string()),
  originalBytes: z.number(),
  truncated: z.boolean(),
}) satisfies Codec<T.DebugTrajectoryRawEntry>;

export const DebugTrajectoryTurn = z.object({
  index: z.number(),
  prompt: z.exactOptional(z.string()),
  startedAt: z.number(),
  endedAt: z.exactOptional(z.number()),
  durationMs: z.exactOptional(z.number()),
  events: z.array(SessionEvent),
  rawEntries: z.array(DebugTrajectoryRawEntry),
  tokens: z.exactOptional(EventTokens),
  silentErrors: z.array(z.string()),
  traceIds: z.array(z.number()),
}) satisfies Codec<T.DebugTrajectoryTurn>;

export const DebugTrajectorySubagentNode = z.object({
  id: z.string(),
  parentId: z.exactOptional(z.string()),
  path: z.string(),
  label: z.string(),
  agentName: z.exactOptional(z.string()),
  status: z.exactOptional(z.string()),
  turnCount: z.number(),
  eventCount: z.number(),
  rawCount: z.number(),
  startedAt: z.exactOptional(z.number()),
  endedAt: z.exactOptional(z.number()),
  traceIds: z.array(z.number()),
}) satisfies Codec<T.DebugTrajectorySubagentNode>;

export const DebugTrajectoryDetail = z.object({
  summary: DebugTrajectorySummary,
  systemPrompt: z.exactOptional(z.string()),
  turns: z.array(DebugTrajectoryTurn),
  subagentPaths: z.array(z.string()),
  subagentNodes: z.array(DebugTrajectorySubagentNode),
  voyageRecordCount: z.number(),
}) satisfies Codec<T.DebugTrajectoryDetail>;

export const DebugTrajectoryGetRequest = z.object({
  id: z.string(),
  kind: z.exactOptional(DebugTrajectoryKind),
}) satisfies Codec<T.DebugTrajectoryGetRequest>;

export const DebugTrajectoryExportRequest = z.object({
  id: z.string(),
  kind: z.exactOptional(DebugTrajectoryKind),
  outDir: z.exactOptional(z.string()),
}) satisfies Codec<T.DebugTrajectoryExportRequest>;

export const DebugTrajectoryExportResult = z.object({
  dir: z.string(),
  replaySpecPath: z.string(),
  conversationId: z.string(),
  sourceKind: z.string(),
  entriesExported: z.number(),
  tasksExported: z.number(),
  conversationsExported: z.number(),
  inspectCmd: z.string(),
  replayCmd: z.string(),
}) satisfies Codec<T.DebugTrajectoryExportResult>;

export const DebugRuntimeSummary = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  ready: z.boolean(),
  version: z.exactOptional(z.string()),
}) satisfies Codec<T.DebugRuntimeSummary>;

export const DebugOverview = z.object({
  channel: z.string(),
  version: z.string(),
  loopbackUrl: z.exactOptional(z.string()),
  homePath: z.string(),
  workRoot: z.string(),
  dbPath: z.string(),
  bundleMode: z.exactOptional(z.string()),
  bootMs: z.exactOptional(z.number()),
  activeSessions: z.number(),
  activeClients: z.number(),
  activeSubscriptions: z.number(),
  latestSeq: z.number(),
  lastFrameMs: z.exactOptional(z.number()),
  runtimes: z.array(DebugRuntimeSummary),
}) satisfies Codec<T.DebugOverview>;

export const DebugGraphClient = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  watches: z.array(z.string()),
  subscriptions: z.array(z.string()),
}) satisfies Codec<T.DebugGraphClient>;

export const DebugGraphSession = z.object({
  sessionId: z.string(),
  issueId: z.exactOptional(z.number()),
  title: z.string(),
  runtime: z.string(),
  status: z.string(),
  worktree: z.exactOptional(z.string()),
  kind: DebugTrajectoryKind,
}) satisfies Codec<T.DebugGraphSession>;

export const DebugGraph = z.object({
  clients: z.array(DebugGraphClient),
  sessions: z.array(DebugGraphSession),
}) satisfies Codec<T.DebugGraph>;

export const DebugCacheStat = z.object({
  name: z.string(),
  entries: z.number(),
  detail: z.exactOptional(z.string()),
}) satisfies Codec<T.DebugCacheStat>;

export const DebugCollabClock = z.object({
  peerId: z.string(),
  counter: z.number(),
}) satisfies Codec<T.DebugCollabClock>;

export const DebugCollabPresence = z.object({
  id: z.string(),
  name: z.string(),
  color: z.exactOptional(z.string()),
  kind: z.string(),
  status: z.exactOptional(z.string()),
  nodeId: z.exactOptional(z.string()),
  path: z.exactOptional(z.string()),
  offset: z.exactOptional(z.number()),
  endOffset: z.exactOptional(z.number()),
  sessionId: z.exactOptional(z.string()),
  updatedAt: z.number(),
}) satisfies Codec<T.DebugCollabPresence>;

export const DebugCollabNoteState = z.object({
  noteId: z.string(),
  title: z.string(),
  noteType: z.string(),
  seq: z.number(),
  snapshotBytes: z.number(),
  frontiers: z.string(),
  frontierIds: z.array(DebugCollabClock),
  versionVector: z.string(),
  vvEntries: z.array(DebugCollabClock),
  ephemeralTtlMs: z.number(),
  presenceCount: z.number(),
  presence: z.array(DebugCollabPresence),
  updatedAt: z.number(),
}) satisfies Codec<T.DebugCollabNoteState>;

export const DebugStateCounts = z.object({
  issues: z.number(),
  sessions: z.number(),
  channels: z.number(),
  agents: z.number(),
  repos: z.number(),
  notes: z.number(),
  inbox: z.number(),
  mediaJobs: z.number(),
}) satisfies Codec<T.DebugStateCounts>;

export const DebugStateCache = z.object({
  seq: z.number(),
  sliceSeqs: z.record(z.string(), z.number()),
  sliceWatchers: z.record(z.string(), z.number()),
  counts: DebugStateCounts,
  caches: z.array(DebugCacheStat),
  collab: z.array(DebugCollabNoteState),
}) satisfies Codec<T.DebugStateCache>;

export const DebugOverrideConfig = z.object({
  rpcDelayMs: z.number(),
  sliceDelayMs: z.number(),
  targetFilter: z.exactOptional(z.string()),
  disconnectTopic: z.exactOptional(z.string()),
}) satisfies Codec<T.DebugOverrideConfig>;

export const DebugBundleResult = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  files: z.array(z.string()),
  redactedCount: z.number(),
}) satisfies Codec<T.DebugBundleResult>;

export const DebugSnapshot = z.object({
  overview: DebugOverview,
  routes: z.unknown(),
  overrides: DebugOverrideConfig,
  graph: DebugGraph,
  stateCache: DebugStateCache,
  recentTimeline: z.array(DebugTimelineEvent),
}) satisfies Codec<T.DebugSnapshot>;
