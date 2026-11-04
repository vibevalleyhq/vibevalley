// The endpoint table, put together from each concept's (<concept>/api.ts). Each endpoint is a POST at its op's path (pathOf); the server routes and the clients call by this list
// (apps/server/src/http/api.ts, VibeValleyApi).

import { Predicate } from "effect";

import { type AgentHandlers, agentEndpoints } from "./agent/api";
import { type ArtifactHandlers, artifactEndpoints } from "./artifact/api";
import { type ChannelHandlers, channelEndpoints } from "./channel/api";
import { type ConnectorHandlers, connectorEndpoints } from "./connector/api";
import { type CoreHandlers, coreEndpoints } from "./core/api";
import { type CronHandlers, cronEndpoints } from "./cron/api";
import type { Endpoint } from "./endpoint";
import { type GameHandlers, gameEndpoints } from "./game/api";
import { type IssueHandlers, issueEndpoints } from "./issue/api";
import { type LanHandlers, lanEndpoints } from "./lan/api";
import { type MemoryHandlers, memoryEndpoints } from "./memory/api";
import { type OrchestratorHandlers, orchestratorEndpoints } from "./orchestrator/api";
import { type PkmHandlers, pkmEndpoints } from "./pkm/api";
import { type ProjectHandlers, projectEndpoints } from "./project/api";
import { type RuntimeHandlers, runtimeEndpoints } from "./runtime/api";
import { type SessionHandlers, sessionEndpoints } from "./session/api";
import { type SettingHandlers, settingEndpoints } from "./setting/api";
import { pathOf } from "./shapes";
import { type VoiceHandlers, voiceEndpoints } from "./voice/api";

export * from "./endpoint";
export type { AgentHandlers } from "./agent/api";
export type { ArtifactHandlers } from "./artifact/api";
export type { ChannelHandlers } from "./channel/api";
export type { ConnectorHandlers } from "./connector/api";
export type { CoreHandlers } from "./core/api";
export type { CronHandlers } from "./cron/api";
export type { GameHandlers } from "./game/api";
export type { IssueHandlers } from "./issue/api";
export type { LanHandlers } from "./lan/api";
export type { MemoryHandlers } from "./memory/api";
export type { OrchestratorHandlers } from "./orchestrator/api";
export type { PkmHandlers } from "./pkm/api";
export type { ProjectHandlers } from "./project/api";
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
    ChannelHandlers<R>,
    CronHandlers<R>,
    VoiceHandlers<R>,
    IssueHandlers<R>,
    SessionHandlers<R>,
    ArtifactHandlers<R>,
    GameHandlers<R>,
    RuntimeHandlers<R>,
    ProjectHandlers<R>,
    AgentHandlers<R>,
    PkmHandlers<R>,
    MemoryHandlers<R>,
    ConnectorHandlers<R>,
    LanHandlers<R> {}

export const endpoints: readonly Endpoint[] = [
  ...coreEndpoints,
  ...orchestratorEndpoints,
  ...settingEndpoints,
  ...channelEndpoints,
  ...cronEndpoints,
  ...voiceEndpoints,
  ...issueEndpoints,
  ...sessionEndpoints,
  ...artifactEndpoints,
  ...gameEndpoints,
  ...runtimeEndpoints,
  ...projectEndpoints,
  ...agentEndpoints,
  ...pkmEndpoints,
  ...memoryEndpoints,
  ...connectorEndpoints,
  ...lanEndpoints,
];

export { pathOf };

/** How the command line writes a word of an op: previewDelete is preview-delete. */
export const kebab = (word: string) => word.replace(/[A-Z]/gu, (c, i: number) => (i > 0 ? "-" : "") + c.toLowerCase());

export const commandOf = (op: keyof Handlers, about: readonly string[] = [], input?: unknown): string[] => [
  ...op.split(".").map(kebab),
  ...about,
  ...(input === undefined ? [] : ["--json", JSON.stringify(input)]),
];

/** Only get, list, check, recall and preview read; every other verb may change something. */
export const readsOnly = (op: string) => /^(get|list|check|recall|search|preview[A-Z]\w*)$/u.test(op.split(".").at(-1) ?? "");

/** The fields an endpoint's input takes, what it is about among them; none when it takes nothing. */
export const fieldsOf = (e: Endpoint): readonly string[] => {
  const s: unknown = e.input;
  return Predicate.hasProperty(s, "fields") && Predicate.isObject(s.fields) ? Object.keys(s.fields) : [];
};
