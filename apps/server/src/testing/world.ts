// The farm's services for tests, the same modules services.ts assembles (platform … issues), with nothing reaching this
// machine's runtimes, GitHub or a model: runtimes come from the test (oar's scriptedRuntime), gh answers that it is not
// there.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Runtime } from "@botiverse/oar";
import type { AccountUsage } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { type Config } from "../base/config.ts";
import { type GitHubRun, type ProjectHooks } from "../project/project.ts";
import { registryOf } from "../runtime/runtime.ts";
import { agentSessions, agents, collaboration, issuesBelowTaskGraphs, platform, type ServiceOptions, sourceControl } from "../services.ts";
import { layer as notice } from "../notice/notice.ts";
import { layer as task } from "../task/task.ts";
import { layer as tool } from "../tool/tool.ts";
import { layer as mcp } from "../mcp/mcp.ts";
import { testConfig } from "./layers.ts";
import { repo } from "./git.ts";
import { installedOnly } from "./helper.ts";
import { clockLayer } from "./clock.ts";

export const noGitHub: GitHubRun = () => Effect.succeed({ out: "", ok: false, missing: true });

export interface WorldOptions {
  readonly config?: Config;
  /** The runtimes sessions run on; each is probed as installed. */
  readonly runtimes?: readonly Runtime[];
  readonly projects?: ProjectHooks;
  /** Projects made before the farm starts, each a git repository with one commit. */
  readonly repos?: readonly string[];
  readonly stallMs?: number;
  /** What now is for the whole farm (Effect's Clock); the real time when absent. */
  readonly clock?: () => number;
  /** What a runtime's account says of its quota or balance; none when absent. */
  readonly usage?: () => AccountUsage | null;
  /** Who an MCP token names; the sessions' tokens when absent. */
  readonly who?: (token: string) => string;
}

/** The farm below the task graphs: for a test that makes its own task service. */
export function worldBelowTasks(options: WorldOptions = {}) {
  const config = options.config ?? testConfig();
  for (const name of options.repos ?? []) {
    const dir = join(config.workRoot, "projects", name);
    mkdirSync(dir, { recursive: true });
    repo(dir, 1, 0);
  }
  const given = options.runtimes ?? [];
  const o: ServiceOptions = {
    runtime: { registry: registryOf(given), background: false, probe: installedOnly(given, options.usage), usageOf: async () => options.usage?.() ?? null },
    project: { gh: noGitHub, ...options.projects },
    ...(options.stallMs !== undefined ? { session: { stallMs: options.stallMs } } : {}),
    issue: { background: false },
  };
  const below = options.clock ? platform(config).pipe(Layer.provideMerge(clockLayer(options.clock))) : platform(config);
  return below.pipe(agents(o), sourceControl(o), collaboration(o), agentSessions(o), issuesBelowTaskGraphs(o));
}

/** The farm up to its notifications, with the tools and /mcp: no orchestrator, gateway or game, and no startup (farm.ts adds
 * it). */
export function world(options: WorldOptions = {}) {
  return worldBelowTasks(options).pipe(on(task()), on(notice), on(tool), on(mcp(options.who ? { who: options.who } : {})));
}

const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));
