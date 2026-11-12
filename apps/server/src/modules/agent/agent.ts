import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Setting } from "#/platform/setting/setting.ts";

import { makeProfileStore, type ProfileStore } from "./profile.ts";
import { makeRuntimeFleet, type RuntimeOptions, type RuntimeFleet } from "./runtime.ts";

/** The agents: their profiles, skills and templates (config.json), the runtimes they run on with their quota and
 * spending, and the farm's own harness. */
export interface Agent extends ProfileStore, RuntimeFleet {
  /** Closes the runtimes (probes, the day's spending, the harness), then the profiles' file. */
  readonly close: () => Promise<void>;
}

export interface AgentDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  /** Only for VibeValley's own runtime, which is not built when options.registry is given. */
  readonly setting: Setting;
  /** How DeepSeek is reached. */
  readonly fetch: typeof fetch;
}

export type AgentOptions = RuntimeOptions;

export async function makeAgent(deps: AgentDeps, options: AgentOptions = {}): Promise<Agent> {
  const profiles = await makeProfileStore(deps);
  let runtimes: RuntimeFleet;
  try {
    runtimes = await makeRuntimeFleet({ ...deps, profiles }, options);
  } catch (e) {
    await profiles.close();
    throw e;
  }
  return {
    ...profiles,
    ...runtimes,
    close: async () => {
      try {
        await runtimes.close();
      } finally {
        await profiles.close();
      }
    },
  };
}
