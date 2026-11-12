import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Runtime } from "@botiverse/oar";

import type { AccountUsage, ChatMessage, IssueRequest } from "@vibevalley/protocol";

import type { Core } from "#/core/core.ts";
import { makeCore } from "#/core/core.ts";
import { makeMcp, type Mcp } from "#/gateway/mcp/mcp.ts";
import { makeProjection } from "#/gateway/projection/frame.ts";
import { type ServerConfig } from "#/infra/config.ts";
import { openDb } from "#/infra/db.ts";
import { makeLogger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import { type Time, wallTime } from "#/infra/time.ts";
import { makeAgent } from "#/modules/agent/agent.ts";
import { makeArtifact } from "#/modules/artifact/artifact.ts";
import { makeAttachment } from "#/modules/attachment/attachment.ts";
import { makeChannel } from "#/modules/channel/channel.ts";
import { makeCron } from "#/modules/cron/cron.ts";
import { type Inbox, makeInbox } from "#/modules/inbox/inbox.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { type Issue, makeIssue } from "#/modules/issue/issue.ts";
import { makeMachine } from "#/modules/machine/machine.ts";
import { makeMailbox } from "#/modules/mailbox/mailbox.ts";
import { makeMedia } from "#/modules/media/media.ts";
import { makeMemory } from "#/modules/memory/memory.ts";
import { makePkm } from "#/modules/pkm/pkm.ts";
import { makeProvider } from "#/modules/provider/provider.ts";
import { type GitHubRun, makeRepo, type RepoHooks } from "#/modules/repo/repo.ts";
import type { ModelAccess } from "#/modules/runtime/durable.ts";
import { makeRuntime, registryOf } from "#/modules/runtime/runtime.ts";
import { makeSession } from "#/modules/session/session.ts";
import { type WorkerAccess, type workerAccess } from "#/modules/session/worker.ts";
import { makeSetting } from "#/modules/setting/setting.ts";
import { makeTool, type Tool } from "#/modules/tool/tool.ts";
import { makeUser } from "#/modules/user/user.ts";
import { type Close, closeAll, type Farm, owning, type ServiceOptions } from "#/services.ts";

import { scriptedDeepSeek, type ScriptedDeepSeek } from "./deepseek.ts";
import { repo } from "./git.ts";
import { offlineNetwork, testConfig } from "./layers.ts";
import { installedOnly } from "./worker.ts";

const noGitHub: GitHubRun = () => Promise.resolve({ out: "", ok: false, missing: true });

/** For a test that builds the whole app (http/app.ts): nothing of this machine's is asked in the background, and the
 * network is the test's (loopback only). */
export const quietApp = {
  runtime: { background: false },
  repo: { gh: noGitHub },
  orchestrator: { listen: false },
  platform: offlineNetwork,
} satisfies ServiceOptions;

export interface WorldOptions {
  readonly workerAccess?: typeof workerAccess;
  readonly config?: ServerConfig;
  /** The runtimes sessions run on; each is probed as installed. */
  readonly runtimes?: readonly Runtime[];
  readonly repoHooks?: RepoHooks;
  /** Repos made before the farm starts, each a git repository with one commit. */
  readonly repos?: readonly string[];
  readonly stallMs?: number;
  /** What a runtime's account says of its quota or balance; none when absent. */
  readonly usage?: () => AccountUsage | null;
  /** Who an MCP token names; the sessions' tokens when absent. */
  readonly who?: (token: string) => string;
  /** The network the farm reaches (testing/network.ts's vendors); loopback only when absent. */
  readonly network?: { readonly fetch: typeof fetch; readonly publicFetch: PublicFetch };
  /** The farm's clock (testing/layers.ts's shiftedTime); the wall clock when absent. */
  readonly clock?: Time;
  /** The DeepSeek the farm's harness asks (the real one, for an eval); the scripted one a test seats when absent. */
  readonly models?: ModelAccess;
}

/** What is said in a test farm, from the farm's start. */
export interface Said {
  readonly in: (channel: string) => ChatMessage[];
  readonly all: () => ChatMessage[];
}

/** Every message the core tells of from now on; closed with the farm. */
function said(core: Core): Said & { readonly close: () => void } {
  const all: ChatMessage[] = [];
  const events = core.subscribe();
  const reading = (async () => {
    for await (const e of events) if (e.type === "messageChanged") all.push(e.message);
  })();
  return {
    in: (channel) => all.filter((m) => m.channel === channel),
    all: () => [...all],
    close: () => {
      events.close();
      // The reader ends with its subscription; nothing it does can fail.
      reading.catch(() => {});
    },
  };
}

/** The test's own worker CLI: there, and every credential lets the helper in. */
const fakeWorkerAccess = async (): Promise<WorkerAccess> => {
  const close = async () => {};
  return {
    executableAvailable: async () => true,
    command: "worker",
    prepare: async () => ({ authenticated: true, command: "worker" }),
    revoke: async () => {},
    close,
    [Symbol.asyncDispose]: close,
  };
};

/** The farm up to its issues (services.ts's makeFarm, cut there), built and not started, with what the test hears. */
export type ModuleWorld = Omit<Farm, "inbox" | "tool" | "orchestrator" | "game" | "mcp" | "lan" | "voice" | "connector"> & {
  /** What the test's own services close with, after the farm's closes; each is called the last added first. */
  readonly closes: Close[];
  readonly said: Said;
  /** What the farm's harness asks for DeepSeek: a test seats its scripted model here. */
  readonly deepseek: Pick<ScriptedDeepSeek, "use">;
};

/** Core domain services below Inbox/Tool/Mcp for module tests: services.ts's order and deps, to the issues. */
export async function moduleWorld(options: WorldOptions = {}): Promise<ModuleWorld> {
  const base = options.config ?? testConfig();
  const config = options.stallMs !== undefined ? { ...base, session: { ...base.session, stallSeconds: options.stallMs / 1000 } } : base;
  for (const name of options.repos ?? []) {
    const dir = join(config.workRoot, "repos", name);
    mkdirSync(dir, { recursive: true });
    repo(dir, 1, 0);
  }
  const given = options.runtimes ?? [];
  const clock = options.clock ?? wallTime;
  const deepseek = scriptedDeepSeek(clock);
  const o: ServiceOptions = {
    runtime: {
      registry: registryOf(given),
      background: false,
      probe: installedOnly(given, options.usage),
      usageOf: async () => options.usage?.() ?? null,
      models: options.models ?? deepseek.models,
    },
    repo: { gh: noGitHub, ...options.repoHooks },
    session: { workerAccess: options.workerAccess ?? fakeWorkerAccess },
  };
  const { fetch, publicFetch } = options.network ?? offlineNetwork;
  const log = makeLogger({ name: "vibevalley" });
  // Closed last: after the harness, whose runs it may still be answering.
  const closes: Close[] = [() => deepseek.close()];
  const own = owning(closes);
  try {
    const db = own(await openDb(config, log.child("db"), clock));
    const projection = makeProjection();
    const core = own(makeCore({ projection, clock }));
    const heard = said(core);
    closes.push(heard.close);
    const setting = own(await makeSetting({ config, clock, log }));
    const user = own(await makeUser({ db, clock, log }));
    const attachment = own(await makeAttachment({ config, clock, db }));
    const provider = own(await makeProvider({ setting, fetch, clock, log }));
    const agent = own(await makeAgent({ config, clock, log }));
    const memory = own(await makeMemory({ clock, log, fetch, db, setting, agent }, o.memory));
    const runtime = own(await makeRuntime({ config, clock, log, db, core, agent, setting, fetch }, o.runtime));
    const repo = own(await makeRepo({ config, clock, log }, o.repo));
    const machine = own(await makeMachine({ config, clock, log, db, core, runtime }));
    const session = own(await makeSession({ config, clock, log, db, core, agent, memory, repo, machine, runtime }, o.session));
    const mailbox = own(await makeMailbox({ db, clock, log, config, core, agent, session }));
    const channel = own(await makeChannel({ clock, log, fetch, db, core, agent, attachment, session, mailbox }));
    const media = own(await makeMedia({ db, core, clock, log, attachment, session, channel, provider, publicFetch }));
    const artifact = own(await makeArtifact({ db, clock, log, attachment, channel }));
    const pkm = own(await makePkm({ config, clock, log, db }));
    const issue = own(await makeIssue({ config, clock, log, db, core, agent, repo, runtime, session, channel, mailbox }));
    const cron = own(await makeCron({ config, clock, log, db, core, agent, channel, issue, mailbox }));
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeAll(closes));
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
      machine,
      session,
      mailbox,
      channel,
      media,
      artifact,
      pkm,
      issue,
      cron,
      closes,
      said: { in: heard.in, all: heard.all },
      deepseek: { use: deepseek.use },
      close,
      [Symbol.asyncDispose]: close,
    };
  } catch (e) {
    await closeAll(closes);
    throw e;
  }
}

/** The farm up to its inbox, with the tools and /mcp: no orchestrator, gateway or game, and no startup (flows/farm.ts
 * adds it). */
export type World = ModuleWorld & { readonly inbox: Inbox; readonly tool: Tool; readonly mcp: Mcp };

export async function world(options: WorldOptions = {}): Promise<World> {
  const below = await moduleWorld(options);
  try {
    const { config, clock, log, db, core, agent, memory, repo, session, mailbox, channel, media, artifact, pkm, issue, cron } = below;
    const own = owning(below.closes);
    const inbox = own(await makeInbox({ config, clock, log, db, core, channel, issue, session, mailbox }));
    const tool = own(await makeTool({ clock, log, agent, session, issue, mailbox, channel, cron, memory, media, pkm, artifact, repo }));
    const mcp = own(await makeMcp({ config, session, tool, log }, options.who ? { who: options.who } : {}));
    return { ...below, inbox, tool, mcp };
  } catch (e) {
    await below.close();
    throw e;
  }
}

/** Issues a test adds are ones the user sent, so their mandate is explicit. */
export const testIssues = (issues: Issue) => ({
  ...issues,
  add: (request: IssueRequest) => issues.add(request, explicitMandate()),
});
