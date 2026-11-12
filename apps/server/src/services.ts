import { type Connector, type ConnectorOptions, makeConnector } from "#/gateway/connector/connector.ts";
import { type Lan, type LanOptions, makeLan } from "#/gateway/lan/lan.ts";
import { makeMcp, type Mcp, type McpOptions } from "#/gateway/mcp/mcp.ts";
import { makeProjection } from "#/gateway/projection/frame.ts";
import { makeTool, type Tool } from "#/gateway/tool/tool.ts";
import { makeVoice, type Voice, type VoiceOptions } from "#/gateway/voice/voice.ts";
import { type Agent, makeAgent } from "#/modules/agent/agent.ts";
import { type Artifact, makeArtifact } from "#/modules/artifact/artifact.ts";
import { type Channel, makeChannel } from "#/modules/channel/channel.ts";
import { type Game, makeGame } from "#/modules/game/game.ts";
import { type Issue, makeIssue } from "#/modules/issue/issue.ts";
import { makeMedia, type Media } from "#/modules/media/media.ts";
import { makeMemory, type Memory, type MemoryOptions } from "#/modules/memory/memory.ts";
import { makeOrchestrator, type Orchestrator, type OrchestratorOptions } from "#/modules/orchestrator/orchestrator.ts";
import { makePkm, type Pkm } from "#/modules/pkm/pkm.ts";
import { makeRepo, type Repo, type RepoHooks } from "#/modules/repo/repo.ts";
import { makeRuntime, type Runtime, type RuntimeOptions } from "#/modules/runtime/runtime.ts";
import { makeSession, type Session, type SessionOptions } from "#/modules/session/session.ts";
import { makeWatch, type Watch } from "#/modules/watch/watch.ts";
import { type Attachment, makeAttachment } from "#/platform/attachment/attachment.ts";
import { makeProvider, type Provider } from "#/platform/provider/provider.ts";
import { makeSetting, type Setting } from "#/platform/setting/setting.ts";
import { makeUser, type User } from "#/platform/user/user.ts";

import { type Core, makeCore, type Projection } from "./core/core.ts";
import type { ServerConfig } from "./infra/config.ts";
import { type Db, openDb } from "./infra/db.ts";
import { type Logger, makeLogger } from "./infra/log.ts";
import { type PublicFetch, publicFetch as publicFetchOf } from "./infra/publicHttp.ts";
import { type Time, wallTime } from "./infra/time.ts";

/** What a test changes in a module: the farm's own otherwise. */
export interface ServiceOptions {
  readonly runtime?: RuntimeOptions;
  readonly repo?: RepoHooks;
  readonly memory?: MemoryOptions;
  readonly session?: SessionOptions;
  readonly orchestrator?: OrchestratorOptions;
  readonly mcp?: McpOptions;
  readonly lan?: LanOptions;
  readonly voice?: VoiceOptions;
  readonly connector?: ConnectorOptions;
  /** The platform's own parts a test gives instead (an offline network, a clock, a logger that keeps its lines). */
  readonly platform?: PlatformParts;
}

/** The parts below every module that do not come from the config. */
export interface PlatformParts {
  readonly clock?: Time;
  readonly log?: Logger;
  readonly fetch?: typeof fetch;
  readonly publicFetch?: PublicFetch;
}

/** The whole farm, every module's service by name. Gateway: every way in from outside; the HTTP API is mounted on these
 * services by http/app.ts. */
export interface Farm extends AsyncDisposable {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly publicFetch: PublicFetch;
  readonly db: Db;
  readonly projection: Projection;
  readonly core: Core;
  readonly setting: Setting;
  readonly user: User;
  readonly attachment: Attachment;
  readonly provider: Provider;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly runtime: Runtime;
  readonly repo: Repo;
  readonly session: Session;
  readonly channel: Channel;
  readonly media: Media;
  readonly artifact: Artifact;
  readonly pkm: Pkm;
  readonly issue: Issue;
  readonly watch: Watch;
  readonly tool: Tool;
  readonly orchestrator: Orchestrator;
  readonly game: Game;
  readonly mcp: Mcp;
  readonly lan: Lan;
  readonly voice: Voice;
  readonly connector: Connector;
  /** Every service's close, the last built first; the database last of all. */
  readonly close: () => Promise<void>;
}

export type Close = () => Promise<void> | void;

/** Keeps each service's close in closes, in the order they are built, and hands the service back. A service that holds
 * nothing has no close. */
export function owning(closes: Close[]): <A extends object>(service: A) => A {
  return (service) => {
    if ("close" in service) {
      const close: unknown = service.close;
      if (typeof close === "function")
        closes.push(async () => {
          await Reflect.apply(close, service, []);
        });
    }
    return service;
  };
}

/** Calls every close, the last built first; one failing does not keep the others from closing, and the first failure
 * is thrown after. */
export async function closeAll(closes: Close[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closes.toReversed()) {
    try {
      await close();
    } catch (e) {
      failures.push(e);
    }
  }
  closes.length = 0;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "the farm did not close cleanly");
}

/** The modules up to the watch (modules.ts's order, through the watch), built and not started: what the farm builds
 * first and what a module test runs on (testing/world.ts). */
export type Modules = Pick<
  Farm,
  | "config"
  | "clock"
  | "log"
  | "fetch"
  | "publicFetch"
  | "db"
  | "projection"
  | "core"
  | "setting"
  | "user"
  | "attachment"
  | "provider"
  | "agent"
  | "memory"
  | "runtime"
  | "repo"
  | "session"
  | "channel"
  | "media"
  | "artifact"
  | "pkm"
  | "issue"
  | "watch"
>;

/** Builds the modules to the watch, each from the services before it, keeping each one's close in closes. heard is
 * handed the core before any module is built on it (a test's listener). */
export async function buildModules(config: ServerConfig, options: ServiceOptions, closes: Close[], heard?: (core: Core) => void): Promise<Modules> {
  const parts = options.platform ?? {};
  const clock = parts.clock ?? wallTime;
  const log = parts.log ?? makeLogger({ name: "vibevalley" });
  const fetch = parts.fetch ?? globalThis.fetch;
  const publicFetch = parts.publicFetch ?? publicFetchOf();
  const own = owning(closes);
  // Platform: the database first (closed last), then the core state and the services every module uses.
  const db = own(await openDb(config, log.child("db"), clock));
  const projection = makeProjection();
  const core = own(makeCore({ projection, clock }));
  heard?.(core);
  const setting = own(await makeSetting({ config, clock, log }));
  const user = own(await makeUser({ db, clock, log }));
  const attachment = own(await makeAttachment({ config, clock, db }));
  const provider = own(await makeProvider({ setting, fetch, clock, log }));
  // Agents: the profiles, their memory, the runtimes they run on.
  const agent = own(await makeAgent({ config, clock, log }));
  const memory = own(await makeMemory({ clock, log, fetch, db, setting, agent }, options.memory));
  const runtime = own(await makeRuntime({ config, clock, log, db, core, agent, setting, fetch }, options.runtime));
  // Source Control: repositories, worktrees, checks, merges and pull requests.
  const repo = own(await makeRepo({ config, clock, log }, options.repo));
  // Agent Sessions: an agent profile at work: its triggers and deliveries, its sessions and runs, their workplaces and
  // the machine they run on.
  const session = own(await makeSession({ config, clock, log, db, core, agent, memory, repo, runtime }, options.session));
  // Collaboration: channels, threads, messages, media and its library, documents, the user's notes.
  const channel = own(await makeChannel({ clock, log, fetch, db, core, attachment }));
  const media = own(await makeMedia({ db, core, clock, log, attachment, session, channel, provider, publicFetch }));
  const artifact = own(await makeArtifact({ db, clock, log, attachment, channel }));
  const pkm = own(await makePkm({ config, clock, log, db }));
  // Issues: the issues and what runs on a schedule.
  const issue = own(await makeIssue({ config, clock, log, db, core, agent, repo, runtime, session, channel }));
  // Watch: the chat's committed events routed to the sessions through the brakes, their threads, talks and receipts in
  // the chat; the user's inbox and the patrol.
  const watch = own(await makeWatch({ config, clock, log, db, core, agent, session, channel, issue }));
  return {
    config,
    clock,
    log,
    fetch,
    publicFetch,
    db,
    projection,
    core,
    setting,
    user,
    attachment,
    provider,
    agent,
    memory,
    runtime,
    repo,
    session,
    channel,
    media,
    artifact,
    pkm,
    issue,
    watch,
  };
}

/** The whole farm: buildModules, then the modules after the watch in module order (modules.ts), then every startup in
 * module order. A failure closes what was built. */
export async function makeFarm(config: ServerConfig, options: ServiceOptions = {}): Promise<Farm> {
  const closes: Close[] = [];
  const own = owning(closes);
  try {
    const modules = await buildModules(config, options, closes);
    const { clock, log, fetch, db, core, setting, user, agent, memory, runtime, repo, session, channel, media, artifact, pkm, watch, issue } = modules;
    const { provider } = modules;
    // Gateway's tools first: the orchestrator holds them (OrchestratorTools), and /mcp serves them to sessions.
    const tool = own(await makeTool({ clock, log, agent, session, issue, channel, memory, media, pkm, artifact, repo }));
    // Orchestrator: the agent that hands the user's work to helpers.
    const orchestrator = own(
      await makeOrchestrator({ clock, log, config, agent, runtime, repo, pkm, session, channel, issue, tools: tool }, options.orchestrator),
    );
    // Gamification: the ledger, progress and achievements, from events only.
    const game = own(await makeGame({ config, clock, log, db, core, repo }));
    // Gateway: every way in from outside; http/app.ts mounts the HTTP API on these services.
    const mcp = own(await makeMcp({ config, session, tool, log }, options.mcp));
    const lan = own(await makeLan({ config, db, user, clock, log, fetch }, options.lan));
    const voice = own(await makeVoice({ config, clock, log, fetch, core, watch, setting, provider, channel, orchestrator }, options.voice));
    const connector = own(await makeConnector({ clock, db, log, fetch, core, channel, watch }, options.connector));

    // Each module's startup once, in module order (modules.ts), each after the ones it is built on.
    // The first look at GitHub.
    await repo.boot();
    // The sessions on the farm when it stopped taken up again (or let go), their open deliveries restored, what was left
    // routed, who waits woken.
    await session.boot();
    // What media waited for.
    await media.boot();
    await issue.boot();
    // The sessions' threads, the chat's events after the watch's cursor (routed through the brakes, each once), then the
    // inbox as it stands and the patrol's rounds.
    await watch.boot();
    // Commits start being counted.
    await game.boot();

    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeAll(closes));
    return {
      ...modules,
      tool,
      orchestrator,
      game,
      mcp,
      lan,
      voice,
      connector,
      close,
      [Symbol.asyncDispose]: close,
    };
  } catch (e) {
    await closeAll(closes);
    throw e;
  }
}
