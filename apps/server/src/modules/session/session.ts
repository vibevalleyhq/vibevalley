import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

import { type Lifecycle, makeLifecycle, type SessionOptions } from "./lifecycle.ts";
import { type Machine, makeMachine } from "./machine.ts";
import { type Mailbox, makeMailbox } from "./mailbox.ts";

export type { SessionOptions };
export type { Hired, HireOptions, RunFinished, RunStore, SessionNews } from "./lifecycle.ts";
export { DeliveryRefused, HireRefused, newsOf, NotRecorded, NotTakenIn, NotWorkFile, runOf } from "./lifecycle.ts";

/** An agent profile doing a piece of work: what triggers it and its deliveries (the mailbox), the sessions and their
 * runs, their workplaces, and the executions on the machine they run on. */
export type Session = Omit<Lifecycle, "news" | "boot" | "restore" | "close"> &
  Omit<Mailbox, "news" | "boot" | "restore" | "close"> &
  Omit<Machine, "close"> & {
    /** Everything the sessions tell, subscribed before it returns: nothing told after is missed. */
    readonly news: Lifecycle["news"];
    /** What the deliveries tell, subscribed before it returns. */
    readonly deliveries: Mailbox["news"];
    /** Brings back the sessions a restart left: their hands, their interrupted runs. */
    readonly restore: Lifecycle["restore"];
    /** Reloads the open deliveries and what has reached whom. */
    readonly restoreDeliveries: Mailbox["restore"];
    /** At startup, after the modules below it started: the sessions back. */
    readonly boot: () => Promise<void>;
    /** At startup, after the channels restored their threads: the open deliveries restored, what was left routed,
     * who waits woken. */
    readonly wake: () => Promise<void>;
    /** The deliveries stop, then the sessions save what a restart needs, then every execution is let go. */
    readonly close: () => Promise<void>;
  };

export interface SessionDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly repo: Repo;
  readonly runtime: Runtime;
}

export async function makeSession(deps: SessionDeps, options: SessionOptions = {}): Promise<Session> {
  const closes: (() => Promise<void>)[] = [];
  // The last built first; one failing does not keep the others open.
  const close = async () => {
    const failures: unknown[] = [];
    for (const c of closes.splice(0).toReversed())
      try {
        await c();
      } catch (e) {
        failures.push(e);
      }
    if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the sessions did not close cleanly");
  };
  try {
    const machine = await makeMachine(deps);
    closes.push(machine.close);
    const lifecycle = await makeLifecycle({ ...deps, machine }, options);
    closes.push(lifecycle.close);
    const mailbox = await makeMailbox({ ...deps, session: lifecycle });
    closes.push(mailbox.close);
    return {
      ...lifecycle,
      ...mailbox,
      here: machine.here,
      executions: machine.executions,
      news: lifecycle.news,
      deliveries: mailbox.news,
      restore: lifecycle.restore,
      restoreDeliveries: mailbox.restore,
      boot: lifecycle.boot,
      wake: mailbox.boot,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
