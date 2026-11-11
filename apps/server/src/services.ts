import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { Llm } from "@vibevalley/ai/llm";

import { Connector, type ConnectorOptions } from "#/gateway/connector/connector.ts";
import { Lan, type LanOptions } from "#/gateway/lan/lan.ts";
import { Mcp, type McpOptions } from "#/gateway/mcp/mcp.ts";
import { layer as projection } from "#/gateway/projection/frame.ts";
import { Voice, type VoiceOptions } from "#/gateway/voice/voice.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Artifact } from "#/modules/artifact/artifact.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { Channel, start as channelStart } from "#/modules/channel/channel.ts";
import { Cron, start as cronStart } from "#/modules/cron/cron.ts";
import { Game, start as gameStart } from "#/modules/game/game.ts";
import { Inbox, start as inboxReady } from "#/modules/inbox/inbox.ts";
import { Issue, start as issueStart } from "#/modules/issue/issue.ts";
import { Library } from "#/modules/library/library.ts";
import { Machine } from "#/modules/machine/machine.ts";
import { Mailbox, start as mailboxStart } from "#/modules/mailbox/mailbox.ts";
import { Media, start as mediaStart } from "#/modules/media/media.ts";
import { Memory } from "#/modules/memory/memory.ts";
import { Orchestrator, type OrchestratorOptions } from "#/modules/orchestrator/orchestrator.ts";
import { Pkm } from "#/modules/pkm/pkm.ts";
import { Provider } from "#/modules/provider/provider.ts";
import { Repo, type RepoHooks, start as repoStart } from "#/modules/repo/repo.ts";
import { type RuntimeOptions, Runtime } from "#/modules/runtime/runtime.ts";
import { Session, ready as sessionReady } from "#/modules/session/session.ts";
import { Setting } from "#/modules/setting/setting.ts";
import { Tool } from "#/modules/tool/tool.ts";
import { User } from "#/modules/user/user.ts";

import { Core } from "./core/core.ts";
import { ServerConfig } from "./infra/config.ts";
import { Database, Db } from "./infra/db.ts";

/** Builds layer on what is below it, keeping what is below. */
const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** What a test changes in a module: the farm's own otherwise. */
export interface ServiceOptions {
  readonly runtime?: RuntimeOptions;
  readonly repo?: RepoHooks;
  readonly orchestrator?: OrchestratorOptions;
  readonly mcp?: McpOptions;
  readonly lan?: LanOptions;
  readonly voice?: VoiceOptions;
  readonly connector?: ConnectorOptions;
}

/** Platform: Node's services (files, paths, processes), an HTTP client, the database, the settings and secrets, the core state. */
export const platform = (config: ServerConfig["Service"]) =>
  Database.pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
    on(Db.layer),
    on(projection),
    on(Core.layer),
    on(Setting.layer),
    on(User.layer),
    on(Attachment.layer),
    on(Provider.layer),
    on(Llm.layer),
  );

/** Agents: the profiles, their memory, the runtimes they run on. */
export const agents =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Agent.layer), on(Memory.layer), on(Runtime.layer(o.runtime)));

/** Source Control: repositories, worktrees, checks, merges and pull requests. */
export const sourceControl =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Repo.layer(o.repo)));

/** Agent Sessions: an agent at work on an issue in a workplace. */
export const agentSessions = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Machine.layer), on(Session.layer));

/** Collaboration: channels, threads, messages, documents, the user's notes; the sessions register as its helpers. */
export const collaboration = <B, E, R>(below: Layer.Layer<B, E, R>) =>
  below.pipe(on(Channel.layer), on(Media.layer), on(Library.layer), on(Artifact.layer), on(Pkm.layer));

/** Mailbox: immutable source triggers, delivery priority, durable per-Session input and the execution pump. */
export const mailbox = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Mailbox.layer));

export const issues = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Issue.layer), on(Cron.layer));

/** Inbox: what in it is news to the user, and the patrol. */
const inbox = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Inbox.layer));

/** Orchestrator: the agent that hands the user's work to helpers, and its tools. */
const orchestrator =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Tool.layer), on(Orchestrator.layer(o.orchestrator)));

/** Gamification: the ledger, progress and achievements, from events only. */
export const gamification = <B, E, R>(below: Layer.Layer<B, E, R>) => below.pipe(on(Game.layer));

/** Gateway: every way in from outside; the HTTP API is mounted on these services by http/app.ts. */
const gateway =
  (o: ServiceOptions = {}) =>
  <B, E, R>(below: Layer.Layer<B, E, R>) =>
    below.pipe(on(Mcp.layer(o.mcp)), on(Lan.layer(o.lan)), on(Voice.layer(o.voice)), on(Connector.layer(o.connector)));

/** Source Control's startup: the first look at GitHub. */
const sourceControlStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(repoStart));
/** Agent Sessions' startup: the sessions on the farm when it stopped are taken up again, or let go. */
export const agentSessionsStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(sessionReady));
/** Collaboration's startup, after the sessions came back: their threads, and what waited for them. */
export const collaborationStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(channelStart), on(mediaStart));
/** Mailbox's startup: restore open deliveries, replay committed messages without a route receipt, then wake sessions. */
export const mailboxReady = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(mailboxStart));
const issuesStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(issueStart), on(cronStart));
/** Inbox's startup, after the sessions and issues came back: what stands is known, the patrol starts its rounds. */
export const inboxStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(inboxReady));
/** Gamification's startup: commits start being counted. */
const gamificationStart = <B, E, R>(built: Layer.Layer<B, E, R>) => built.pipe(on(gameStart));

/** The whole farm: every module built, then every startup in module order. */
export const services = (config: ServerConfig["Service"], options: ServiceOptions = {}) =>
  platform(config).pipe(
    agents(options),
    sourceControl(options),
    agentSessions,
    mailbox,
    collaboration,
    issues,
    inbox,
    orchestrator(options),
    gamification,
    gateway(options),
    sourceControlStart,
    agentSessionsStart,
    mailboxReady,
    collaborationStart,
    issuesStart,
    inboxStart,
    gamificationStart,
  );
