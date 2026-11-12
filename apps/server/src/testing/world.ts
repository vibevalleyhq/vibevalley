import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Runtime } from "@botiverse/oar";

import type { AccountUsage, ChatMessage, IssueRequest } from "@vibevalley/protocol";

import type { Core } from "#/core/core.ts";
import { makeMcp, type Mcp } from "#/gateway/mcp/mcp.ts";
import { makeTool, type Tool } from "#/gateway/tool/tool.ts";
import { type ServerConfig } from "#/infra/config.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import { type Time, wallTime } from "#/infra/time.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { type Issue } from "#/modules/issue/issue.ts";
import { type GitHubRun, type RepoHooks } from "#/modules/repo/repo.ts";
import type { ModelAccess } from "#/modules/runtime/durable.ts";
import { registryOf } from "#/modules/runtime/runtime.ts";
import { type Inside, insideOf } from "#/modules/session/session.ts";
import { type WorkerAccess, type workerAccess } from "#/modules/session/worker.ts";
import { buildModules, type Close, closeAll, type Modules, owning, type ServiceOptions } from "#/services.ts";

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
  /** VibeValley's own runtime too, on the farm's harness, probed as installed. */
  readonly ownRuntime?: boolean;
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

/** The farm up to its watch (services.ts's buildModules), built and not started, with what the test hears. */
export type ModuleWorld = Modules &
  AsyncDisposable & {
    /** The parts behind the session module, for the tests that drive them. */
    readonly inside: Inside;
    readonly close: () => Promise<void>;
    /** What the test's own services close with, after the farm's closes; each is called the last added first. */
    readonly closes: Close[];
    readonly said: Said;
    /** What the farm's harness asks for DeepSeek: a test seats its scripted model here. */
    readonly deepseek: Pick<ScriptedDeepSeek, "use">;
  };

/** Core domain services below Tool/Mcp for module tests: services.ts's buildModules, with the test's runtimes, repos and network. */
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
      registry: options.ownRuntime === true ? (own) => registryOf([...given, own]) : registryOf(given),
      background: false,
      probe: installedOnly(options.ownRuntime === true ? [...given, { id: "vibevalley" }] : given, options.usage),
      usageOf: async () => options.usage?.() ?? null,
      models: options.models ?? deepseek.models,
    },
    repo: { gh: noGitHub, ...options.repoHooks },
    session: { workerAccess: options.workerAccess ?? fakeWorkerAccess },
  };
  const network = options.network ?? offlineNetwork;
  // Closed last: after the harness, whose runs it may still be answering.
  const closes: Close[] = [() => deepseek.close()];
  const ear: { heard?: ReturnType<typeof said> } = {};
  try {
    const modules = await buildModules(config, { ...o, platform: { ...network, clock } }, closes, (core) => {
      ear.heard = said(core);
      closes.push(ear.heard.close);
    });
    const heard = ear.heard;
    if (heard === undefined) throw new Error("the farm was built without its core");
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeAll(closes));
    return {
      ...modules,
      inside: insideOf(modules.session),
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

/** The farm up to its watch, with the tools and /mcp: no orchestrator, gateway or game, and no startup (flows/farm.ts
 * adds it). */
export type World = ModuleWorld & { readonly tool: Tool; readonly mcp: Mcp };

export async function world(options: WorldOptions = {}): Promise<World> {
  const below = await moduleWorld(options);
  try {
    const { clock, log, agent, memory, repo, session, channel, media, artifact, pkm, issue, config } = below;
    const own = owning(below.closes);
    const tool = own(await makeTool({ clock, log, agent, session, issue, channel, memory, media, pkm, artifact, repo }));
    const mcp = own(await makeMcp({ config, session, tool, log }, options.who ? { who: options.who } : {}));
    return { ...below, tool, mcp };
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
