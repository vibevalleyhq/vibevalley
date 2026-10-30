// The agents' own tasks (agent/brain agentTask.ts) in the farm's database, table agent_task, one open graph per keeper
// (a session of the vibevalley runtime).

import { Clock, Effect, Schema } from "effect";

import { finished, type AgentTask } from "@vibevalley/agent/agentTask";
import type { AgentTaskStore } from "@vibevalley/agent/agentTaskStore";
import { toolFailed } from "@vibevalley/agent/core/errors";

import { Db } from "@/base/db.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";

import * as q from "../../db/generated/agent_task.sql.ts";

const afterOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const fromRow = (r: q.OpenAgentTasksResult): AgentTask => ({
  id: r.id,
  title: r.title,
  brief: r.brief,
  after: afterOf(r.after) ?? [],
  by: r.executor,
  state: r.state,
  ...(r.result ? { result: r.result } : {}),
  ...(r.tries !== 0 ? { tries: r.tries } : {}),
});

/** A finished graph stays, stamped finished_at: putting it away only empties the keeper's open graph. */
export const dbStores: Effect.Effect<(keeper: string) => AgentTaskStore, never, Db> = Effect.gen(function* () {
  const db = yield* Db;
  return (keeper) => ({
    load: Effect.map(db.run(q.openAgentTasks({ keeper })), (rows) => rows.map(fromRow)),
    change: <G extends AgentTask[] | undefined>(f: (g: AgentTask[]) => G) =>
      db.inTx(
        Effect.gen(function* () {
          const rows = yield* db.run(q.openAgentTasks({ keeper }));
          const g = yield* Effect.try({ try: () => f(rows.map(fromRow)), catch: toolFailed });
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
  });
});
