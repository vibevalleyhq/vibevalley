import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Runtime } from "@botiverse/oar";

import type { AccountUsage, ChatMessage, IssueRequest } from "@vibevalley/protocol";

import type { Core } from "#/core/core.ts";
import { makeMcp, type Mcp } from "#/gateway/mcp/mcp.ts";
import { type ServerConfig } from "#/infra/config.ts";
import { type Inbox, makeInbox } from "#/modules/inbox/inbox.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { type GitHubRun, type RepoHooks } from "#/modules/repo/repo.ts";
import { registryOf } from "#/modules/runtime/runtime.ts";
import { type WorkerAccess, type workerAccess } from "#/modules/session/worker.ts";
import { makeTool, type Tool } from "#/modules/tool/tool.ts";
import {
  agentSessions,
  agents,
  type Building,
  closeAll,
  collaboration,
  issues,
  type IssuesFarm,
  mailbox,
  platform,
  type ServiceOptions,
  sourceControl,
} from "#/services.ts";

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

/** The farm up to its issues, built and not started, with what the test hears. */
export type ModuleWorld = IssuesFarm & Building & AsyncDisposable & { readonly said: Said; readonly close: () => Promise<void> };

/** Core domain services below Inbox/Tool/Mcp for module tests. */
export async function moduleWorld(options: WorldOptions = {}): Promise<ModuleWorld> {
  const base = options.config ?? testConfig();
  const config = options.stallMs !== undefined ? { ...base, session: { ...base.session, stallSeconds: options.stallMs / 1000 } } : base;
  for (const name of options.repos ?? []) {
    const dir = join(config.workRoot, "repos", name);
    mkdirSync(dir, { recursive: true });
    repo(dir, 1, 0);
  }
  const given = options.runtimes ?? [];
  const o: ServiceOptions = {
    runtime: { registry: registryOf(given), background: false, probe: installedOnly(given, options.usage), usageOf: async () => options.usage?.() ?? null },
    repo: { gh: noGitHub, ...options.repoHooks },
    session: { workerAccess: options.workerAccess ?? fakeWorkerAccess },
  };
  const below = await platform(config, offlineNetwork);
  try {
    const heard = said(below.core);
    below.closes.push(heard.close);
    const built = await issues(await collaboration(await mailbox(await agentSessions(await sourceControl(await agents(below, o), o), o))));
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= closeAll(built));
    return Object.assign(built, { said: { in: heard.in, all: heard.all }, close, [Symbol.asyncDispose]: close });
  } catch (e) {
    await closeAll(below);
    throw e;
  }
}

/** The farm up to its inbox, with the tools and /mcp: no orchestrator, gateway or game, and no startup (flows/farm.ts
 * adds it). */
export type World = ModuleWorld & { readonly inbox: Inbox; readonly tool: Tool; readonly mcp: Mcp };

export async function world(options: WorldOptions = {}): Promise<World> {
  const below = await moduleWorld(options);
  try {
    const inbox = await makeInbox(below);
    below.closes.push(() => inbox.close());
    const tool = await makeTool(below);
    const withTool = Object.assign(below, { inbox, tool });
    const mcp = await makeMcp(withTool, options.who ? { who: options.who } : {});
    below.closes.push(() => mcp.close());
    return Object.assign(withTool, { mcp });
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
