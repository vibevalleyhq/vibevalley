import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Runtime } from "@botiverse/oar";
import { Context, Effect, Layer, Stream } from "effect";

import type { AccountUsage, ChatMessage, IssueRequest } from "@vibevalley/protocol";

import { Core } from "#/core/core.ts";
import { Mcp } from "#/gateway/mcp/mcp.ts";
import { type ServerConfig } from "#/infra/config.ts";
import { Inbox } from "#/modules/inbox/inbox.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { type GitHubRun, type RepoHooks } from "#/modules/repo/repo.ts";
import { registryOf } from "#/modules/runtime/runtime.ts";
import { WorkerAccess, type workerAccess } from "#/modules/session/worker.ts";
import { Tool } from "#/modules/tool/tool.ts";
import { agentSessions, agents, collaboration, issues, mailbox, platform, type ServiceOptions, sourceControl } from "#/services.ts";

import { repo } from "./git.ts";
import { offlineNetwork, testConfig } from "./layers.ts";
import { installedOnly } from "./worker.ts";

const noGitHub: GitHubRun = () => Effect.succeed({ out: "", ok: false, missing: true });

/** For a test that builds the whole app (http/app.ts): nothing of this machine's is asked in the background. */
export const quietApp = {
  runtime: { background: false },
  repo: { gh: noGitHub },
  orchestrator: { listen: false },
} satisfies ServiceOptions;

export interface WorldOptions {
  readonly workerAccess?: typeof workerAccess;
  readonly config?: ServerConfig["Service"];
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

/** Core domain services below Inbox/Tool/Mcp for module tests. */
export function moduleWorld(options: WorldOptions = {}) {
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
  };
  const below = platform(config).pipe(Layer.provideMerge(offlineNetwork));
  return said.pipe(
    Layer.provideMerge(below),
    agents(o),
    sourceControl(o),
    on(
      Layer.succeed(
        WorkerAccess,
        options.workerAccess ??
          Effect.succeed({
            executableAvailable: Effect.succeed(true),
            command: "worker",
            prepare: () => Effect.succeed({ authenticated: true, command: "worker" }),
            revoke: () => Effect.void,
          }),
      ),
    ),
    agentSessions,
    mailbox,
    collaboration,
    issues,
  );
}

/** The farm up to its inbox, with the tools and /mcp: no orchestrator, gateway or game, and no startup (farm.ts adds
 * it). */
export function world(options: WorldOptions = {}) {
  return moduleWorld(options).pipe(on(Inbox.layer), on(Tool.layer), on(Mcp.layer(options.who ? { who: options.who } : {})));
}

const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** Issues a test adds are ones the user sent, so their mandate is explicit. */
export const testIssues = (issues: Issue["Service"]) => ({
  ...issues,
  add: (request: IssueRequest) => issues.add(request, explicitMandate()),
});

// What is said in a test farm, from the farm's start.

export class Said extends Context.Service<
  Said,
  {
    readonly in: (channel: string) => ChatMessage[];
    readonly all: () => ChatMessage[];
  }
>()("@vibevalley/server/testing/world/Said") {}

export const said = Layer.effect(
  Said,
  Effect.gen(function* () {
    const core = yield* Core;
    const all: ChatMessage[] = [];
    const events = yield* core.subscribe;
    yield* Effect.forkScoped(Stream.runForEach(events, (e) => Effect.sync(() => void (e.type === "messageChanged" && all.push(e.message)))));
    return Said.of({ in: (channel) => all.filter((m) => m.channel === channel), all: () => [...all] });
  }),
);
