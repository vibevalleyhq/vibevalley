// The farm's services, module by module (modules.ts): each module assembles its own services on the modules below it, and
// what goes the other way is news on a stream. Two phases: every module is built first, subscribing to what it follows;
// then each module's startup runs, in module order, so whatever a startup says reaches every module already listening.
// Some modules still do startup work while they are built (putting their state back into the core); ordering by data
// instead is .agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md. The tests assemble the same modules
// (testing/world.ts).

import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import { Llm } from "@vibevalley/ai/llm";

import { Agents } from "./agent/agent.ts";
import { Artifacts, type ArtifactOptions } from "./artifact/artifact.ts";
import { ServerConfig } from "./base/config.ts";
import { Database, Db } from "./base/db.ts";
import { Channels } from "./channel/chat.ts";
import { Connectors, type ConnectorOptions } from "./connector/connector.ts";
import { Core } from "./core/core.ts";
import { Crons, start as cronStart } from "./cron/cron.ts";
import { Game, start as gameStart } from "./game/game.ts";
import { Issues, type IssueOptions } from "./issue/issue.ts";
import { Lan, type LanOptions } from "./lan/lan.ts";
import { Mcp, type McpOptions } from "./mcp/mcp.ts";
import { Memories } from "./memory/memory.ts";
import { Notices, start as noticeStart } from "./notice/notice.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator/orchestrator.ts";
import { Projects, type ProjectHooks, start as projectStart } from "./project/project.ts";
import { layer as projection } from "./projection/projection.ts";
import { type RuntimeOptions, Runtimes } from "./runtime/runtime.ts";
import { Sessions, ready as sessionReady, type SessionOptionsIn } from "./session/session.ts";
import { Setting } from "./setting/setting.ts";
import { Tasks, start as taskGraphStart, type TaskOptions } from "./task/task.ts";
import { Tools } from "./tool/tool.ts";
import { Voice, type VoiceOptions } from "./voice/voice.ts";

/** Builds layer on what is below it, keeping what is below. */
const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** What a test changes in a module: the farm's own otherwise. */
export interface ServiceOptions {
  readonly runtime?: RuntimeOptions;
  readonly project?: ProjectHooks;
  readonly artifact?: ArtifactOptions;
  readonly session?: SessionOptionsIn;
  readonly issue?: IssueOptions;
  readonly task?: TaskOptions;
  readonly orchestrator?: OrchestratorOptions;
  readonly mcp?: McpOptions;
  readonly lan?: LanOptions;
  readonly voice?: VoiceOptions;
  readonly connector?: ConnectorOptions;
}

/** Platform: Node's services (files, paths, processes), an HTTP client, the database, the settings and secrets, the core state (folded by
 * the projection, which reads every module's rules). */
export const platform = (config: ServerConfig["Service"]) =>
  Database.pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    on(Db.layer),
    on(projection),
    on(Core.layer),
    on(Setting.layer),
    on(Llm.layer),
  );

/** Agents: the profiles, their memory, the runtimes they run on. */
export const agents =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Agents.layer), on(Memories.layer), on(Runtimes.layer(o.runtime)));

/** Source Control: repositories, worktrees, checks, merges and pull requests. */
export const sourceControl =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Projects.layer(o.project)));

/** Agent Sessions: an agent at work on a job in a workplace. */
export const agentSessions =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Sessions.layer(o.session)));

/** Collaboration: channels, threads, messages, documents; the sessions register as its helpers. */
export const collaboration =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Channels.layer), on(Artifacts.layer(o.artifact)));

/** Issues without its task graphs: for a test that makes its own task service. */
export const issuesBelowTaskGraphs =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Crons.layer), on(Issues.layer(o.issue)));

/** Issues: the issues, their task graphs and crons. */
const issues =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    issuesBelowTaskGraphs(o)(below).pipe(on(Tasks.layer(o.task)));

/** Notifications: what in the inbox is news to the owner, and the patrol. */
const notifications = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Notices.layer));

/** Orchestrator: the agent that hands the owner's work to helpers, and its tools. */
const orchestrator =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Tools.layer), on(Orchestrator.layer(o.orchestrator)));

/** Gamification: the ledger, progress and achievements, from events only. */
export const gamification = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Game.layer));

/** Gateway: every way in from outside; the HTTP API is mounted on these services by http/app.ts. */
const gateway =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Mcp.layer(o.mcp)), on(Lan.layer(o.lan)), on(Voice.layer(o.voice)), on(Connectors.layer(o.connector)));

/** Source Control's startup: the first look at GitHub. */
const sourceControlStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(projectStart));
/** Agent Sessions' startup: the sessions on the farm when it stopped are taken up again, or let go. */
export const agentSessionsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(sessionReady));
/** Issues' startup, after the sessions came back: the task graphs cut off by the stop are settled, then the crons start
 * coming due. */
const issuesStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(taskGraphStart), on(cronStart));
/** Issues' startup without the crons' clock: for a test farm that ticks them by hand. */
export const taskGraphsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(taskGraphStart));
/** Notifications' startup, after the sessions and issues came back: what stands is known, the patrol starts its rounds. */
export const notificationsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(noticeStart));
/** Gamification's startup: commits start being counted. */
const gamificationStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(gameStart));

/** The whole farm: every module built, then every startup in module order. */
export const services = (config: ServerConfig["Service"], options: ServiceOptions = {}) =>
  platform(config).pipe(
    agents(options),
    sourceControl(options),
    collaboration(options),
    agentSessions(options),
    issues(options),
    notifications,
    orchestrator(options),
    gamification,
    gateway(options),
    sourceControlStart,
    agentSessionsStart,
    issuesStart,
    notificationsStart,
    gamificationStart,
  );
