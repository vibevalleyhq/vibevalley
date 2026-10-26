// Where one keeper's open tasks live, for the brain, which is Promise code. change applies f to the open graph and
// keeps what it returns, all at once; a finished graph is put away and the keeper's open graph is empty again. It answers
// the graph as kept, before putting it away, so the caller can still say how it ended.

import { Clock, Effect, FiberSet, Schema, type Scope } from "effect";
import * as q from "../../../db/generated/agent_task.sql.ts";
import { Db } from "../../base/db.ts";
import { newId } from "../../base/ids.ts";
import { jsonOrNone } from "../../base/json.ts";
import { type By, finished, type State, type AgentTask } from "./agentTask.ts";

export interface AgentTaskStore {
  readonly load: () => Promise<AgentTask[]>;
  /** f returning undefined changes nothing: nothing is written, and the answer is undefined. A throw from f leaves the
   * graph as it was and is the rejection. */
  readonly change: <G extends AgentTask[] | undefined>(f: (g: AgentTask[]) => G) => Promise<G>;
}

const afterOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const fromRow = (r: q.OpenAgentTasksResult): AgentTask => ({
  id: r.id,
  title: r.title,
  brief: r.brief,
  after: afterOf(r.after) ?? [],
  by: r.executor as By,
  state: r.state as State,
  ...(r.result ? { result: r.result } : {}),
  ...(r.tries ? { tries: r.tries } : {}),
});

/** The farm's database (agent_task), on fibers of the service that asks: they end with it, and its Clock stamps when a
 * graph changed and finished. A finished graph stays, stamped finished_at. */
export const dbStores: Effect.Effect<(keeper: string) => AgentTaskStore, never, Db | Scope.Scope> = Effect.gen(function* () {
  const db = yield* Db;
  const run = yield* FiberSet.makeRuntimePromise<never>();
  const open = (keeper: string) => Effect.map(db.run(q.openAgentTasks({ keeper })), (rows) => rows.map(fromRow));
  return (keeper) => ({
    load: () => run(open(keeper)),
    change: <G extends AgentTask[] | undefined>(f: (g: AgentTask[]) => G) =>
      run(
        db.inTx(
          Effect.gen(function* () {
            const rows = yield* db.run(q.openAgentTasks({ keeper }));
            const g = yield* Effect.try({ try: () => f(rows.map(fromRow)), catch: (e) => e });
            if (g === undefined) return g;
            // The graph keeps its id while it is open; a new one starts when the keeper had none.
            const graph = rows[0]?.graph ?? newId();
            yield* db.run(q.clearOpenAgentTasks({ keeper }));
            const at = yield* Clock.currentTimeMillis;
            for (const [position, t] of g.entries())
              yield* db.run(
                q.addAgentTask({
                  graph,
                  keeper,
                  id: t.id,
                  position,
                  title: t.title,
                  brief: t.brief,
                  after: JSON.stringify(t.after),
                  executor: t.by,
                  state: t.state,
                  result: t.result ?? "",
                  tries: t.tries ?? 0,
                  updated_at: at,
                }),
              );
            if (finished(g)) yield* db.run(q.finishAgentTasks({ finished_at: at, keeper }));
            return g;
          }),
        ),
      ),
  });
});

/** For an agent with no farm behind it (the command line): the graph lasts as long as the process. */
export function memoryStore(): AgentTaskStore {
  let g: AgentTask[] = [];
  return {
    load: async () => [...g],
    change: async (f) => {
      const next = f([...g]);
      if (next !== undefined) g = finished(next) ? [] : next;
      return next;
    },
  };
}
