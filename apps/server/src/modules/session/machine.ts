import type * as T from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import { hostName, type ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";
import { addHereMachine, hereMachine } from "#db/session_machine.sql.ts";

import { type Executions, makeExecutor } from "./executor.ts";
import { linked } from "./link.ts";

/** The computers helpers work on. Today only the server's own, kept from its first start; machines that join from
 * the command line come in with the machine link (.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md). */
export interface Machine {
  /** The server's own machine: where a helper hired now works. */
  readonly here: () => T.Machine;
  /** The helpers' runs on a machine, reached over the link. */
  readonly executions: (machine: T.Machine) => Executions;
  /** Lets go of every execution, waiting a while for each runtime to confirm. */
  readonly close: () => Promise<void>;
}

export interface MachineDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly runtime: Runtime;
}

export async function makeMachine(deps: MachineDeps): Promise<Machine> {
  const { db, core, clock } = deps;
  const executor = makeExecutor(deps);
  const kept = await hereMachine(db.sql);
  const at = clock.now();
  const row = kept ?? { id: newId(at), name: hostName(), joined_at: at };
  if (kept === undefined) await addHereMachine(db.sql, row);
  const here: T.Machine = { id: row.id, name: row.name, here: true, online: true, joinedAt: row.joined_at };
  core.apply({ type: "machineChanged", machine: here });
  // The one machine there is, in this process: its executor behind the link.
  const hereExecutions = linked(executor);
  return { here: () => here, executions: () => hereExecutions, close: executor.closeAll };
}
