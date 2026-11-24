import { z } from "zod";

import { type AgentHandlers, agentEndpoints } from "./agent/api";
import { type ArtifactHandlers, artifactEndpoints } from "./artifact/api";
import { type AttachmentHandlers, attachmentEndpoints } from "./attachment/api";
import { type ChannelHandlers, channelEndpoints } from "./channel/api";
import { type ConnectorHandlers, connectorEndpoints } from "./connector/api";
import { type CoreHandlers, coreEndpoints } from "./core/api";
import { type CronHandlers, cronEndpoints } from "./cron/api";
import { type DebugHandlers, debugEndpoints } from "./debug/api";
import type { Caller, Endpoint } from "./endpoint";
import { type GameHandlers, gameEndpoints } from "./game/api";
import { type IssueHandlers, issueEndpoints } from "./issue/api";
import { type MachineHandlers, machineEndpoints } from "./machine/api";
import { type MediaHandlers, mediaEndpoints } from "./media/api";
import { type MemoryHandlers, memoryEndpoints } from "./memory/api";
import { type OrchestratorHandlers, orchestratorEndpoints } from "./orchestrator/api";
import { type ProviderHandlers, providerEndpoints } from "./provider/api";
import { type RemoteHandlers, remoteEndpoints } from "./remote/api";
import { type RepoHandlers, repoEndpoints } from "./repo/api";
import { type RuntimeHandlers, runtimeEndpoints } from "./runtime/api";
import * as S from "./schema";
import { type SessionHandlers, sessionEndpoints } from "./session/api";
import { type SettingHandlers, settingEndpoints } from "./setting/api";
import { type VoiceHandlers, voiceEndpoints } from "./voice/api";

export * from "./endpoint";

/** One answer per route: the server's Handlers. */
export interface Handlers
  extends
    CoreHandlers,
    DebugHandlers,
    RemoteHandlers,
    MachineHandlers,
    OrchestratorHandlers,
    SettingHandlers,
    ProviderHandlers,
    MediaHandlers,
    ChannelHandlers,
    CronHandlers,
    VoiceHandlers,
    IssueHandlers,
    SessionHandlers,
    ArtifactHandlers,
    GameHandlers,
    RuntimeHandlers,
    RepoHandlers,
    AgentHandlers,
    MemoryHandlers,
    ConnectorHandlers,
    AttachmentHandlers {}

export const endpoints: readonly Endpoint[] = [
  ...coreEndpoints,
  ...debugEndpoints,
  ...remoteEndpoints,
  ...machineEndpoints,
  ...orchestratorEndpoints,
  ...settingEndpoints,
  ...providerEndpoints,
  ...mediaEndpoints,
  ...channelEndpoints,
  ...cronEndpoints,
  ...voiceEndpoints,
  ...issueEndpoints,
  ...sessionEndpoints,
  ...artifactEndpoints,
  ...gameEndpoints,
  ...runtimeEndpoints,
  ...repoEndpoints,
  ...agentEndpoints,
  ...memoryEndpoints,
  ...connectorEndpoints,
  ...attachmentEndpoints,
];

const userAndRemote: readonly Caller[] = ["user", "remote"];

/** Each subscription's payload, allowed callers, and the Schema of each event it then sends, by name. */
export const subscriptions = {
  /** What changed in a channel after the revision after, then each change from now on, each the message as it now is. */
  "channel.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ChannelEvent },
  /** The turn reports in any channel after the one with this id (by message id, which sorts by time), or the newest
   * when absent, then each report from now on. */
  "channel.reports": { can: userAndRemote, payload: z.object({ after: z.exactOptional(z.string()) }), event: S.ChannelEvent },
  /** A blocks artifact's changes after this seq, then each batch from now on. */
  "artifact.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEvent },
  /** A store artifact's entry changes after this seq, then each batch from now on. */
  "artifact.entry.follow": { can: userAndRemote, payload: z.object({ id: z.string(), after: z.number() }), event: S.ArtifactEntryEvent },
  /** An artifact's suggestions as they now are, then the whole list after each change. */
  "artifact.suggestion.follow": { can: userAndRemote, payload: z.object({ id: z.string() }), event: S.SuggestionEvent },
  /** An artifact's ephemeral live presence peers as a snapshot, then incremental upserts and removals. */
  "artifact.presence.follow": { can: userAndRemote, payload: S.ArtifactPresenceFollowRequest, event: S.ArtifactPresenceEvent },
  /** One session's state, pending permissions/interactions, and live trajectory events after afterSeq. */
  "session.watch": { can: userAndRemote, payload: z.object({ id: z.string(), afterSeq: z.exactOptional(z.number()) }), event: S.SessionWatchEvent },
} as const;

export type SubscriptionName = keyof typeof subscriptions;
