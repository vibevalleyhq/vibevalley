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
import { type ActWords, type IssueAction, pathOf } from "./shapes";
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
const sameAs: Partial<Record<keyof Handlers, readonly string[]>> = {
  "issue.list": ["issue", "list"],
  "issue.get": ["issue", "show"],
  "issue.diff.get": ["issue", "diff"],
  "issue.timeline.get": ["issue", "timeline"],
  "session.list": ["session", "list"],
  "session.get": ["session", "show"],
  "session.stop": ["session", "stop"],
  "project.list": ["project", "list"],
  "agent.list": ["agent", "list"],
  "runtime.list": ["runtime", "list"],
  "runtime.refresh": ["runtime", "refresh"],
  "memory.list": ["memory", "list"],
  "cron.list": ["cron", "list"],
  "channel.list": ["channel", "list"],
  "artifact.list": ["artifact", "list"],
  "artifact.get": ["artifact", "show"],
  "artifact.content.get": ["artifact", "read"],
  "pkm.page.list": ["pkm", "page", "list"],
  "pkm.page.get": ["pkm", "page", "show"],
};

/** The command that does one of an issue's acts (without `vibevalley`): a move is `issue status <n> <status>`, words to
 * its helper `issue comment <n>`, stopping its helper `session stop <helper>`. Words it still needs are not in it: words
 * says whether the act takes them, and where they go (`--comment` after a move, the words after a comment). */
export function actCommand(
  issue: { readonly number: number },
  a: IssueAction,
  session: string | undefined,
): { readonly run: readonly string[]; readonly words: ActWords } | undefined {
  const n = String(issue.number);
  switch (a.does) {
    case "move":
      return { run: ["issue", "status", n, a.status], words: a.words };
    case "say":
      return { run: ["issue", "comment", n], words: "required" };
    case "stop":
      return session === undefined ? undefined : { run: ["session", "stop", session], words: "none" };
  }
}

/** A command that does what op does with these arguments (about: its `about` fields, in order) and input, as a next step
 * says it (without `vibevalley`): the endpoint's own command when it has one, else `api call` with the whole input. */
export const commandOf = (op: keyof Handlers, about: readonly string[] = [], input?: Record<string, unknown>): string[] => {
  const same = sameAs[op];
  if (same && input === undefined) return [...same, ...about];
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
