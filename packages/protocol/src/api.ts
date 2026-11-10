import { type AgentHandlers, agentEndpoints } from "./agent/api";
import { type ArtifactHandlers, artifactEndpoints } from "./artifact/api";
import { type ChannelHandlers, channelEndpoints } from "./channel/api";
import { type ConnectorHandlers, connectorEndpoints } from "./connector/api";
import { type CoreHandlers, coreEndpoints } from "./core/api";
import { type CronHandlers, cronEndpoints } from "./cron/api";
import type { Endpoint } from "./endpoint";
import { type GameHandlers, gameEndpoints } from "./game/api";
import { actCommand, type IssueHandlers, issueEndpoints } from "./issue/api";
import { type LanHandlers, lanEndpoints } from "./lan/api";
import { type MediaHandlers, mediaEndpoints } from "./media/api";
import { type MemoryHandlers, memoryEndpoints } from "./memory/api";
import { type OrchestratorHandlers, orchestratorEndpoints } from "./orchestrator/api";
import { type PkmHandlers, pkmEndpoints } from "./pkm/api";
import { type ProviderHandlers, providerEndpoints } from "./provider/api";
import { type RepoHandlers, repoEndpoints } from "./repo/api";
import { type RuntimeHandlers, runtimeEndpoints } from "./runtime/api";
import { type SessionHandlers, sessionEndpoints } from "./session/api";
import { type SettingHandlers, settingEndpoints } from "./setting/api";
import { type UserHandlers, userEndpoints } from "./user/api";
import { type VoiceHandlers, voiceEndpoints } from "./voice/api";

export * from "./endpoint";
export { actCommand };
export type { AgentHandlers } from "./agent/api";
export type { ArtifactHandlers } from "./artifact/api";
export type { ChannelHandlers } from "./channel/api";
export type { ConnectorHandlers } from "./connector/api";
export type { CoreHandlers } from "./core/api";
export type { CronHandlers } from "./cron/api";
export type { GameHandlers } from "./game/api";
export type { IssueHandlers } from "./issue/api";
export type { LanHandlers } from "./lan/api";
export type { UserHandlers } from "./user/api";
export type { MemoryHandlers } from "./memory/api";
export type { OrchestratorHandlers } from "./orchestrator/api";
export type { PkmHandlers } from "./pkm/api";
export type { ProviderHandlers } from "./provider/api";
export type { MediaHandlers } from "./media/api";
export type { RepoHandlers } from "./repo/api";
export type { RuntimeHandlers } from "./runtime/api";
export type { SessionHandlers } from "./session/api";
export type { SettingHandlers } from "./setting/api";
export type { VoiceHandlers } from "./voice/api";

/** One answer per route: the server's Handlers. */
export interface Handlers<R = never>
  extends
    CoreHandlers<R>,
    OrchestratorHandlers<R>,
    SettingHandlers<R>,
    ProviderHandlers<R>,
    MediaHandlers<R>,
    ChannelHandlers<R>,
    CronHandlers<R>,
    VoiceHandlers<R>,
    IssueHandlers<R>,
    SessionHandlers<R>,
    ArtifactHandlers<R>,
    GameHandlers<R>,
    RuntimeHandlers<R>,
    RepoHandlers<R>,
    AgentHandlers<R>,
    PkmHandlers<R>,
    MemoryHandlers<R>,
    ConnectorHandlers<R>,
    LanHandlers<R>,
    UserHandlers<R> {}

export const endpoints: readonly Endpoint[] = [
  ...coreEndpoints,
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
  ...pkmEndpoints,
  ...memoryEndpoints,
  ...connectorEndpoints,
  ...lanEndpoints,
  ...userEndpoints,
];
