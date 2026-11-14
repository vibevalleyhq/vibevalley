import { RuntimeRegistry } from "@botiverse/oar";

import { type Core, makeCore } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { type Agent, type AgentOptions, makeAgent } from "#/modules/agent/agent.ts";
import { makeSetting, type Setting } from "#/platform/setting/setting.ts";

import { offlineNetwork } from "./layers.ts";

/** The pieces a test below the whole farm already has; a core and the settings are made when not given. */
export interface AgentParts {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core?: Core;
  readonly setting?: Setting;
}

/** The agent module on its own: no runtime unless options give one, nothing probed in the background, no network. Its
 * close closes what it made (the settings, the core), not what it was given. */
export async function testAgent(parts: AgentParts, options: AgentOptions = {}): Promise<Agent> {
  const { config, clock, log, db } = parts;
  const core =
    parts.core ??
    makeCore({
      projection: {
        reduce: (state) => [state, false],
        effects: () => [],
        frame: () => {
          throw new Error("no frame is drawn in an agent test");
        },
      },
      clock,
    });
  const setting = parts.setting ?? (await makeSetting({ config, clock, log }));
  const agent = await makeAgent(
    { config, clock, log, db, core, setting, fetch: offlineNetwork.fetch },
    { registry: new RuntimeRegistry([]), background: false, ...options },
  );
  return {
    ...agent,
    close: async () => {
      try {
        await agent.close();
      } finally {
        if (parts.setting === undefined) await setting.close();
        if (parts.core === undefined) core.close();
      }
    },
  };
}
