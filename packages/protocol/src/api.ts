import { type AgentHandlers, agentEndpoints } from "./agent/api";
import { type ArtifactHandlers, artifactEndpoints } from "./artifact/api";
import { type AttachmentHandlers, attachmentEndpoints } from "./attachment/api";
import { type ChannelHandlers, channelEndpoints } from "./channel/api";
import { type ConnectorHandlers, connectorEndpoints } from "./connector/api";
import { type CoreHandlers, coreEndpoints } from "./core/api";
import { type CronHandlers, cronEndpoints } from "./cron/api";
import { type DebugHandlers, debugEndpoints } from "./debug/api";
import type { Endpoint } from "./endpoint";
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
