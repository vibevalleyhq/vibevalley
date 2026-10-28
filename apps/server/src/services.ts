// The farm's services, module by module (modules.ts): each module assembles its own services on the modules below it, and
// what goes the other way is news on a stream. Two phases: every module is built first, subscribing to what it follows;
// then each module's startup runs, in module order, so whatever a startup says reaches every module already listening.
// Some modules still do startup work while they are built (putting their state back into the core); ordering by data
// instead is .agents/notes/proposed/architecture/2026-10-22-commit-then-effects.md. The tests assemble the same modules
// (testing/world.ts).

import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FetchHttpClient } from "effect/http";
import { layer as agent } from "./agent/agent.ts";
import { type Config, Settings } from "./base/config.ts";
import { Database, DbLayer } from "./base/db.ts";
import { layer as core } from "./core/core.ts";
import { layer as artifact } from "./artifact/artifact.ts";
import { layer as channel } from "./channel/chat.ts";
import { type DocOptions, layer as doc } from "./doc/doc.ts";
import { type IssueOptions, layer as issue } from "./issue/issue.ts";
import { layer as memory } from "./memory/memory.ts";
import { layer as projection } from "./projection/projection.ts";
import { layer as notice, start as noticeStart } from "./notice/notice.ts";
import { layer as project, type ProjectHooks, start as projectStart } from "./project/project.ts";
import { layer as runtime, type RuntimeOptions } from "./runtime/runtime.ts";
import { layer as session, ready as sessionReady, type SessionOptionsIn } from "./session/session.ts";
import { layer as cron, start as cronStart } from "./cron/cron.ts";
import { layer as setting } from "./setting/setting.ts";
import { layer as llm } from "@vibevalley/ai/llm";
import { start as taskGraphStart, layer as task, type TaskOptions } from "./task/task.ts";
import { layer as tool } from "./tool/tool.ts";
import { layer as mcp, type McpOptions } from "./mcp/mcp.ts";
import { layer as orchestrators, type OrchestratorOptions } from "./orchestrator/orchestrator.ts";
import { layer as game, start as gameStart } from "./game/game.ts";
import { layer as lan, type LanOptions } from "./lan/lan.ts";
import { layer as voice, type VoiceOptions } from "./voice/voice.ts";
import { type ConnectorOptions, layer as connector } from "./connector/connector.ts";

/** Builds layer on what is below it, keeping what is below. */
const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** What a test changes in a module: the farm's own otherwise. */
export interface ServiceOptions {
  readonly runtime?: RuntimeOptions;
  readonly project?: ProjectHooks;
  readonly doc?: DocOptions;
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
export const platform = (config: Config) =>
  Database.pipe(
    Layer.provideMerge(Layer.succeed(Settings, config)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    on(DbLayer),
    on(projection),
    on(core),
    on(setting),
    on(llm),
  );

/** Agents: the profiles, their memory, the runtimes they run on. */
export const agents =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(agent), on(memory), on(runtime(o.runtime)));

/** Source Control: repositories, worktrees, checks, merges and pull requests. */
export const sourceControl =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(project(o.project)));

/** Agent Sessions: an agent at work on a job in a workplace. */
export const agentSessions =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(session(o.session)));

/** Collaboration: channels, threads, messages, documents; the sessions register as its helpers. */
export const collaboration =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(doc(o.doc)), on(channel), on(artifact));

/** Issues without its task graphs: for a test that makes its own task service. */
export const issuesBelowTaskGraphs =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(cron), on(issue(o.issue)));

/** Issues: the issues, their task graphs and crons. */
export const issues =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    issuesBelowTaskGraphs(o)(below).pipe(on(task(o.task)));

/** Notifications: what in the inbox is news to the owner, and the patrol. */
export const notifications = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(notice));

/** Orchestrator: the agent that hands the owner's work to helpers, and its tools. */
export const orchestrator =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(tool), on(orchestrators(o.orchestrator)));

/** Gamification: the ledger, progress and achievements, from events only. */
export const gamification = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(game));

/** Gateway: every way in from outside; the HTTP API is mounted on these services by http/app.ts. */
export const gateway =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(mcp(o.mcp)), on(lan(o.lan)), on(voice(o.voice)), on(connector(o.connector)));

/** Source Control's startup: the first look at GitHub. */
export const sourceControlStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(projectStart));
/** Agent Sessions' startup: the sessions on the farm when it stopped are taken up again, or let go. */
export const agentSessionsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(sessionReady));
/** Issues' startup, after the sessions came back: the task graphs cut off by the stop are settled, then the crons start
 * coming due. */
export const issuesStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(taskGraphStart), on(cronStart));
/** Issues' startup without the crons' clock: for a test farm that ticks them by hand. */
export const taskGraphsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(taskGraphStart));
/** Notifications' startup, after the sessions and issues came back: what stands is known, the patrol starts its rounds. */
export const notificationsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(noticeStart));
/** Gamification's startup: commits start being counted. */
export const gamificationStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(gameStart));

/** The whole farm: every module built, then every startup in module order. */
export const services = (config: Config, options: ServiceOptions = {}) =>
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
