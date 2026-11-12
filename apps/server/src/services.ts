import { type Llm, makeLlm } from "@vibevalley/ai/llm";

import { type Connector, type ConnectorOptions, makeConnector } from "#/gateway/connector/connector.ts";
import { type Lan, type LanOptions, makeLan } from "#/gateway/lan/lan.ts";
import { makeMcp, type Mcp, type McpOptions } from "#/gateway/mcp/mcp.ts";
import { makeProjection } from "#/gateway/projection/frame.ts";
import { makeVoice, type Voice, type VoiceOptions } from "#/gateway/voice/voice.ts";
import { type Agent, makeAgent } from "#/modules/agent/agent.ts";
import { type Artifact, makeArtifact } from "#/modules/artifact/artifact.ts";
import { type Attachment, makeAttachment } from "#/modules/attachment/attachment.ts";
import { type Channel, makeChannel } from "#/modules/channel/channel.ts";
import { type Cron, makeCron } from "#/modules/cron/cron.ts";
import { type Game, makeGame } from "#/modules/game/game.ts";
import { type Inbox, makeInbox } from "#/modules/inbox/inbox.ts";
import { type Issue, makeIssue } from "#/modules/issue/issue.ts";
import { type Library, makeLibrary } from "#/modules/library/library.ts";
import { type Machine, makeMachine } from "#/modules/machine/machine.ts";
import { type Mailbox, makeMailbox } from "#/modules/mailbox/mailbox.ts";
import { makeMedia, type Media } from "#/modules/media/media.ts";
import { makeMemory, type Memory, type MemoryOptions } from "#/modules/memory/memory.ts";
import { makeOrchestrator, type Orchestrator, type OrchestratorOptions } from "#/modules/orchestrator/orchestrator.ts";
import { makePkm, type Pkm } from "#/modules/pkm/pkm.ts";
import { makeProvider, type Provider } from "#/modules/provider/provider.ts";
import { makeRepo, type Repo, type RepoHooks } from "#/modules/repo/repo.ts";
import { makeRuntime, type Runtime, type RuntimeOptions } from "#/modules/runtime/runtime.ts";
import { makeSession, type Session, type SessionOptions } from "#/modules/session/session.ts";
import { makeSetting, type Setting } from "#/modules/setting/setting.ts";
import { makeTool, type Tool } from "#/modules/tool/tool.ts";
import { makeUser, type User } from "#/modules/user/user.ts";

import { type Core, makeCore, type Projection } from "./core/core.ts";
import type { ServerConfig } from "./infra/config.ts";
import { type Db, openDb } from "./infra/db.ts";
import { type Logger, makeLogger } from "./infra/log.ts";
import { type PublicFetch, publicFetch } from "./infra/publicHttp.ts";
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

/** Platform: the settings and secrets, the clock, the log, the network, the database, the core state. */
export interface PlatformFarm {
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
  readonly llm: Llm;
}

/** Agents: the profiles, their memory, the runtimes they run on. */
export interface AgentsFarm extends PlatformFarm {
  readonly agent: Agent;
  readonly memory: Memory;
  readonly runtime: Runtime;
}

/** Source Control: repositories, worktrees, checks, merges and pull requests. */
export interface SourceControlFarm extends AgentsFarm {
  readonly repo: Repo;
}

/** Agent Sessions: an agent at work on an issue in a workplace. */
export interface AgentSessionsFarm extends SourceControlFarm {
  readonly machine: Machine;
  readonly session: Session;
}

/** Mailbox: immutable source triggers, delivery priority, durable per-Session input and the execution pump. */
export interface MailboxFarm extends AgentSessionsFarm {
  readonly mailbox: Mailbox;
}

/** Collaboration: channels, threads, messages, documents, the user's notes; the sessions register as its helpers. */
export interface CollaborationFarm extends MailboxFarm {
  readonly channel: Channel;
  readonly media: Media;
  readonly library: Library;
  readonly artifact: Artifact;
  readonly pkm: Pkm;
}

export interface IssuesFarm extends CollaborationFarm {
  readonly issue: Issue;
  readonly cron: Cron;
}

/** Inbox: what in it is news to the user, and the patrol. */
export interface InboxFarm extends IssuesFarm {
  readonly inbox: Inbox;
}

/** Orchestrator: the agent that hands the user's work to helpers, and its tools. */
export interface OrchestratorFarm extends InboxFarm {
  readonly tool: Tool;
  readonly orchestrator: Orchestrator;
}

/** Gamification: the ledger, progress and achievements, from events only. */
export interface GamificationFarm extends OrchestratorFarm {
  readonly game: Game;
}

/** The whole farm. Gateway: every way in from outside; the HTTP API is mounted on these services by http/app.ts. */
export interface Farm extends GamificationFarm, AsyncDisposable {
  readonly mcp: Mcp;
  readonly lan: Lan;
  readonly voice: Voice;
  readonly connector: Connector;
  /** Every service's close, the last built first; the database last of all. */
  readonly close: () => Promise<void>;
}

/** What is built so far, and how to take it down: each stage below adds to it. */
export interface Building {
  /** The closes of what is built, in the order it was built. */
  readonly closes: (() => Promise<void> | void)[];
}

/** Its close, when it has one: a service that holds nothing has none. */
function closeOf(service: object): (() => Promise<void> | void) | undefined {
  if (!("close" in service)) return undefined;
  const close: unknown = service.close;
  if (typeof close !== "function") return undefined;
  return async () => {
    await Reflect.apply(close, service, []);
  };
}

/** Adds the services to what is built, keeping their closes. */
function add<B extends Building, A extends object>(below: B, added: A): B & A {
  for (const service of Object.values(added) as unknown[]) {
    if (typeof service !== "object" || service === null) continue;
    const close = closeOf(service);
    if (close) below.closes.push(close);
  }
  return Object.assign(below, added);
}

/** Calls every close, the last built first; one failing does not keep the others from closing, and the first failure
 * is thrown after. */
export async function closeAll(built: Building): Promise<void> {
  const failures: unknown[] = [];
  for (const close of built.closes.toReversed()) {
    try {
      await close();
    } catch (e) {
      failures.push(e);
    }
  }
  built.closes.length = 0;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "the farm did not close cleanly");
}

/** Platform: the database first (closed last), then the core state and the services every module uses. */
export async function platform(config: ServerConfig, parts: PlatformParts = {}): Promise<PlatformFarm & Building> {
  const clock = parts.clock ?? wallTime;
  const log = parts.log ?? makeLogger({ name: "vibevalley" });
  const fetcher = parts.fetch ?? globalThis.fetch;
  const built: Building = { closes: [] };
  const db = await openDb(config, log.child("db"), clock);
  built.closes.push(() => db.close());
  try {
    const projection = makeProjection();
    const core = makeCore({ projection, clock });
    built.closes.push(() => core.close());
    const base = { config, clock, log, fetch: fetcher, publicFetch: parts.publicFetch ?? publicFetch(), db, projection, core, ...built };
    const withSetting = add(base, { setting: await makeSetting(base) });
    const withUser = add(withSetting, { user: await makeUser(withSetting) });
    const withAttachment = add(withUser, { attachment: await makeAttachment(withUser) });
    const withProvider = add(withAttachment, { provider: await makeProvider(withAttachment) });
    return add(withProvider, { llm: makeLlm({ fetch: fetcher, clock }) });
  } catch (e) {
    await closeAll(built);
    throw e;
  }
}

/** Each stage builds on what is below it and keeps it; a failure is the caller's to close (closeAll). */
export const agents = async <B extends PlatformFarm & Building>(below: B, o: ServiceOptions = {}) => {
  const withAgent = add(below, { agent: await makeAgent(below) });
  const withMemory = add(withAgent, { memory: await makeMemory(withAgent, o.memory) });
  return add(withMemory, { runtime: await makeRuntime(withMemory, o.runtime) });
};

export const sourceControl = async <B extends AgentsFarm & Building>(below: B, o: ServiceOptions = {}) => add(below, { repo: await makeRepo(below, o.repo) });

export const agentSessions = async <B extends SourceControlFarm & Building>(below: B, o: ServiceOptions = {}) => {
  const withMachine = add(below, { machine: await makeMachine(below) });
  return add(withMachine, { session: await makeSession(withMachine, o.session) });
};

export const mailbox = async <B extends AgentSessionsFarm & Building>(below: B) => add(below, { mailbox: await makeMailbox(below) });

export const collaboration = async <B extends MailboxFarm & Building>(below: B) => {
  const withChannel = add(below, { channel: await makeChannel(below) });
  const withMedia = add(withChannel, { media: await makeMedia(withChannel) });
  const withLibrary = add(withMedia, { library: await makeLibrary(withMedia) });
  const withArtifact = add(withLibrary, { artifact: await makeArtifact(withLibrary) });
  return add(withArtifact, { pkm: await makePkm(withArtifact) });
};

export const issues = async <B extends CollaborationFarm & Building>(below: B) => {
  const withIssue = add(below, { issue: await makeIssue(below) });
  return add(withIssue, { cron: await makeCron(withIssue) });
};

const inbox = async <B extends IssuesFarm & Building>(below: B) => add(below, { inbox: await makeInbox(below) });

const orchestrator = async <B extends InboxFarm & Building>(below: B, o: ServiceOptions = {}) => {
  const withTool = add(below, { tool: await makeTool(below) });
  return add(withTool, { orchestrator: await makeOrchestrator(withTool, o.orchestrator) });
};

export const gamification = async <B extends SourceControlFarm & Building>(below: B) => add(below, { game: await makeGame(below) });

const gateway = async <B extends GamificationFarm & Building>(below: B, o: ServiceOptions = {}) => {
  const withMcp = add(below, { mcp: await makeMcp(below, o.mcp) });
  const withLan = add(withMcp, { lan: await makeLan(withMcp, o.lan) });
  const withVoice = add(withLan, { voice: await makeVoice(withLan, o.voice) });
  return add(withVoice, { connector: await makeConnector(withVoice, o.connector) });
};

/** Source Control's startup: the first look at GitHub. */
const sourceControlBoot = (farm: SourceControlFarm) => farm.repo.boot();
/** Agent Sessions' startup: the sessions on the farm when it stopped are taken up again, or let go. */
export const agentSessionsBoot = (farm: AgentSessionsFarm) => farm.session.boot();
/** Collaboration's startup, after the sessions came back: their threads, before the mailbox wakes anyone. */
export const channelBoot = (farm: CollaborationFarm) => farm.channel.boot();
/** Mailbox's startup: restore open deliveries, replay committed messages without a route receipt, then wake sessions. */
export const mailboxBoot = (farm: MailboxFarm) => farm.mailbox.boot();
/** The rest of Collaboration's startup, after the mailbox: what media waited for. */
export const mediaBoot = (farm: CollaborationFarm) => farm.media.boot();
const issuesBoot = async (farm: IssuesFarm) => {
  await farm.issue.boot();
  await farm.cron.boot();
};
/** Inbox's startup, after the sessions and issues came back: what stands is known, the patrol starts its rounds. */
export const inboxBoot = (farm: InboxFarm) => farm.inbox.boot();
/** Gamification's startup: commits start being counted. */
const gamificationBoot = (farm: { readonly game: Game }) => farm.game.boot();

/** The whole farm: every module built, then every startup in module order. A failure closes what was built. */
async function makeFarm(config: ServerConfig, options: ServiceOptions = {}, base: PlatformParts = options.platform ?? {}): Promise<Farm> {
  const below = await platform(config, base);
  try {
    const built = await gateway(
      await gamification(
        await orchestrator(
          await inbox(
            await issues(await collaboration(await mailbox(await agentSessions(await sourceControl(await agents(below, options), options), options)))),
          ),
          options,
        ),
      ),
      options,
    );
    await sourceControlBoot(built);
    await agentSessionsBoot(built);
    await channelBoot(built);
    await mailboxBoot(built);
    await mediaBoot(built);
    await issuesBoot(built);
    await inboxBoot(built);
    await gamificationBoot(built);
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeAll(built));
    return Object.assign(built, { close, [Symbol.asyncDispose]: close });
  } catch (e) {
    await closeAll(below);
    throw e;
  }
}

/** The whole farm, started: what http/app.ts serves. */
export const services = makeFarm;
