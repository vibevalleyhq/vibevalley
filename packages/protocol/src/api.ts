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
import { type IssueAct, pathOf } from "./shapes";
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

/** Endpoints with a command of their own that takes the same arguments, by that command (the command line's, apps/server
 * src/cli): what commandOf writes for them; every other endpoint is written as `api call`. */
const sameAs: Partial<Record<keyof Handlers, { readonly words: readonly string[]; readonly after?: readonly string[] }>> = {
  "issue.list": { words: ["issue", "list"] },
  "issue.get": { words: ["issue", "show"] },
  "issue.diff.get": { words: ["issue", "show"], after: ["--diff"] },
  "issue.timeline.get": { words: ["issue", "show"], after: ["--log"] },
  "session.list": { words: ["session", "list"] },
  "session.get": { words: ["session", "show"] },
  "session.stop": { words: ["session", "stop"] },
  "project.list": { words: ["project", "list"] },
  "agent.list": { words: ["agent", "list"] },
  "runtime.list": { words: ["runtime", "list"] },
  "cron.list": { words: ["cron", "list"] },
  "channel.list": { words: ["channel", "list"] },
  "artifact.list": { words: ["artifact", "list"] },
  "artifact.get": { words: ["artifact", "show"] },
  "pkm.page.list": { words: ["pkm", "list"] },
};

/** The command line's verbs for what can be done with an issue (`issue accept 12`). */
export const IssueVerbValues = ["work", "say", "accept", "stop", "cancel"] as const;
export type IssueVerb = (typeof IssueVerbValues)[number];

/** The verb each of an issue's acts is asked for by: the server's next steps say an act this way, and the command line
 * asks for the act by it. Few verbs, each the thing done, the act the one the issue offers now: work sends it out (and
 * reopens a closed one first), say talks to its helper (an answer when it asks, sending it back when it waits for review). */
export const issueVerbs: Readonly<Record<IssueAct, IssueVerb>> = {
  start: "work",
  resume: "work",
  cure: "work",
  resolve: "work",
  answer: "say",
  tell: "say",
  reject: "say",
  complete: "accept",
  acknowledge: "accept",
  stop: "stop",
  close: "cancel",
  reopen: "work",
};

/** A command that does what op does with these arguments (about: its `about` fields, in order) and input, as a next step
 * says it (without `vibevalley`): the endpoint's own command when it has one, else `api call` with the whole input. */
export const commandOf = (op: keyof Handlers, about: readonly string[] = [], input?: Record<string, unknown>): string[] => {
  const same = sameAs[op];
  if (same && input === undefined) return [...same.words, ...about, ...(same.after ?? [])];
  const names = endpoints.find((e) => e.op === op)?.about ?? [];
  const fields = { ...Object.fromEntries(names.flatMap((name, i) => (about[i] === undefined ? [] : [[name, about[i]]]))), ...input };
  return ["api", "call", op, ...(Object.keys(fields).length > 0 ? ["--json", JSON.stringify(fields)] : [])];
};

/** Only get, list, check, recall and preview read; every other verb may change something. */
export const readsOnly = (op: string) => /^(get|list|check|recall|search|preview[A-Z]\w*)$/u.test(op.split(".").at(-1) ?? "");

/** The fields an endpoint's input takes, what it is about among them; none when it takes nothing. */
export const fieldsOf = (e: Endpoint): readonly string[] => {
  const s: unknown = e.input;
  return Predicate.hasProperty(s, "fields") && Predicate.isObject(s.fields) ? Object.keys(s.fields) : [];
};
