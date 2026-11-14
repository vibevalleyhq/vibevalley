import type { Clock } from "@vibevalley/async";

import type { ServerConfig } from "#/infra/config.ts";
import { type Db, openDb } from "#/infra/db.ts";
import { keptLog } from "#/infra/log.ts";
import { type Time, wallTime } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { makeSetting, type Setting } from "#/platform/setting/setting.ts";
import { testAgent } from "#/testing/agent.ts";

import { makeMemory, type Memory, type MemoryOptions } from "./memory.ts";

/** The memory service and what it stands on, for a test: closed in reverse when disposed. */
export interface MemoryWorld extends AsyncDisposable {
  readonly config: ServerConfig;
  readonly db: Db;
  readonly setting: Setting;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly log: ReturnType<typeof keptLog>;
}

/** clock: the farm's time (now and sleep); fetch: what the sources outside the farm are reached with (none by default). */
export async function memoryWorld(
  config: ServerConfig,
  options: MemoryOptions & { readonly clock?: Clock; readonly fetch?: typeof fetch } = {},
): Promise<MemoryWorld> {
  const given = options.clock;
  const clock: Time = given ? { ...wallTime, now: () => given.now(), sleep: (ms, signal) => given.sleep(ms, signal) } : wallTime;
  const log = keptLog("memory-test");
  const db = await openDb(config, log, clock);
  const setting = await makeSetting({ config, clock, log });
  const agent = await testAgent({ config, clock, log, db, setting });
  const fetch =
    options.fetch ??
    (() => {
      throw new Error("a memory test reached for the network");
    });
  const memory = await makeMemory({ clock, log, fetch, db, setting, agent }, options);
  return {
    config,
    db,
    setting,
    agent,
    memory,
    log,
    [Symbol.asyncDispose]: async () => {
      await memory.close();
      await agent.close();
      await setting.close();
      await db.close();
    },
  };
}
