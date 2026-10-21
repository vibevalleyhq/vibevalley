// The farm's services for tests, built in workspace order as services.ts builds them, with nothing reaching this machine's
// runtimes, GitHub or a model: runtimes come from the test (oar's scriptedRuntime), gh answers that it is not there.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Runtime } from "@botiverse/oar";
import type { AccountUsage, RuntimeInfo } from "@vibevalley/protocol";
import { factsOf, presetOf } from "@vibevalley/protocol/rules";
import { Effect, Layer } from "effect";
import { layer as agent } from "../agent/agent.ts";
import { type Config, Settings } from "../base/config.ts";
import { Database } from "../base/db.ts";
import { layer as core } from "../core/core.ts";
import { layer as doc } from "../doc/doc.ts";
import { layer as memory } from "../memory/memory.ts";
import { type GitHubRun, layer as project, type ProjectHooks } from "../project/project.ts";
import { layer as runtime, registryOf } from "../runtime/runtime.ts";
import { layer as channel } from "../channel/chat.ts";
import { layer as issue } from "../issue/issue.ts";
import { layer as schedule } from "../schedule/schedule.ts";
import { layer as session } from "../session/session.ts";
import { layer as setting } from "../setting/setting.ts";
import { layer as task } from "../task/task.ts";
import { layer as tool } from "../tool/tool.ts";
import { layer as mcp } from "../mcp/mcp.ts";
import { testConfig } from "./layers.ts";
import { repo } from "./git.ts";

export const noGitHub: GitHubRun = () => Effect.succeed({ out: "", ok: false, missing: true });

export interface WorldOptions {
  readonly config?: Config;
  /** The runtimes sessions run on; each is probed as installed. */
  readonly runtimes?: readonly Runtime[];
  readonly projects?: ProjectHooks;
  /** Projects made before the farm starts, each a git repository with one commit. */
  readonly repos?: readonly string[];
  readonly stallMs?: number;
  /** The schedules' clock. */
  readonly now?: () => number;
  /** What a runtime's account says of its quota or balance; none when absent. */
  readonly usage?: () => AccountUsage | null;
  /** Who an MCP token names; the sessions' tokens when absent. */
  readonly who?: (token: string) => string;
}

/** A probe that finds every runtime given, bundled, and no other. */
const installed =
  (given: readonly Runtime[], usage: () => AccountUsage | null = () => null) =>
  async (id: string): Promise<RuntimeInfo> => ({
    id,
    preset: presetOf(id),
    facts: factsOf(id),
    installation: given.some((r) => r.id === id) ? { status: "available", via: "bundled", command: id, version: null } : { status: "not_found" },
    models: null,
    usage: given.some((r) => r.id === id) ? usage() : null,
    skills: null,
    mcpServers: null,
    tools: null,
    settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
    checkedAt: Date.now(),
  });

const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** The farm below the task graphs: for a test that makes its own task service. */
export function worldBelowTasks(options: WorldOptions = {}) {
  const config = options.config ?? testConfig();
  for (const name of options.repos ?? []) {
    const dir = join(config.workRoot, "projects", name);
    mkdirSync(dir, { recursive: true });
    repo(dir, 1, 0);
  }
  const given = options.runtimes ?? [];
  const lower = Database.pipe(
    Layer.provideMerge(Layer.succeed(Settings, config)),
    on(core),
    on(setting),
    on(agent),
    on(project({ gh: noGitHub, ...options.projects })),
    on(memory),
    on(doc()),
    on(runtime({ registry: registryOf(given), background: false, probe: installed(given, options.usage), usageOf: async () => options.usage?.() ?? null })),
    on(session(options.stallMs !== undefined ? { stallMs: options.stallMs } : {})),
    on(channel),
    on(schedule(options.now ? { now: options.now } : {})),
    on(issue({ background: false })),
  );
  return lower;
}

export function world(options: WorldOptions = {}) {
  return worldBelowTasks(options).pipe(on(task()), on(tool), on(mcp(options.who ? { who: options.who } : {})));
}
