import { Clock, Context, Effect, Layer } from "effect";

import type * as T from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { Executor } from "#/executor/executor.ts";
import { hostName } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { addHereMachine, hereMachine } from "#db/machine.sql.ts";

import { type Executions, linked } from "./link.ts";

/** The computers helpers work on. Today only the server's own, kept from its first start; machines that join from
 * the command line come in with the machine link (.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md). */
export class Machine extends Context.Service<
  Machine,
  {
    /** The server's own machine: where a helper hired now works. */
    readonly here: () => T.Machine;
    /** The helpers' runs on a machine, reached over the link. */
    readonly executions: (machine: T.Machine) => Executions;
  }
>()("@vibevalley/server/machine/machine") {
  static readonly layer = Layer.effect(
    Machine,
    Effect.gen(function* () {
      const db = yield* Db;
      const executor = yield* Executor;
      const core = yield* Core;
      const kept = yield* db.one(hereMachine());
      const at = yield* Clock.currentTimeMillis;
      const row = kept ?? { id: newId(at), name: hostName(), joined_at: at };
      if (kept === undefined) yield* db.run(addHereMachine(row));
      const here: T.Machine = { id: row.id, name: row.name, here: true, online: true, joinedAt: row.joined_at };
      yield* core.apply({ type: "machineChanged", machine: here });
      // The one machine there is, in this process: its executor behind the link.
      const hereExecutions = linked(executor);
      return Machine.of({ here: () => here, executions: () => hereExecutions });
    }),
  );
}
