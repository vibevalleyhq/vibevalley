// Where one keeper's open tasks live. change applies f to the open graph and
// keeps what it returns, all at once; a finished graph is put away and the keeper's open graph is empty again. It answers
// the graph as kept, before putting it away, so the caller can still say how it ended.

import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as q from "../../../db/generated/agent_task.sql.ts";
import { newId } from "../../base/ids.ts";
import { jsonOrNone } from "../../base/json.ts";
import { type By, finished, type State, type AgentTask } from "./agentTask.ts";

export interface AgentTaskStore {
  readonly load: Effect.Effect<AgentTask[]>;
  readonly change: <E>(f: (g: AgentTask[]) => Effect.Effect<AgentTask[], E>) => Effect.Effect<AgentTask[], E>;
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

/** The farm's database (agent_task). A finished graph stays, stamped finished_at. */
/** now: the service's Clock, for when a graph changed and finished. */
export const dbStore = (sql: SqlClient.SqlClient, keeper: string, now: () => number): AgentTaskStore => {
  const db = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provideService(e, SqlClient.SqlClient, sql).pipe(Effect.orDie);
  return {
    load: Effect.map(db(q.openAgentTasks({ keeper })), (rows) => rows.map(fromRow)),
    change: <E>(f: (g: AgentTask[]) => Effect.Effect<AgentTask[], E>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* db(q.openAgentTasks({ keeper }));
            const g = yield* f(rows.map(fromRow));
            // The graph keeps its id while it is open; a new one starts when the keeper had none.
            const graph = rows[0]?.graph ?? newId();
            yield* db(q.clearOpenAgentTasks({ keeper }));
            const at = now();
            for (const [position, t] of g.entries())
              yield* db(
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
            if (finished(g)) yield* db(q.finishAgentTasks({ finished_at: at, keeper }));
            return g;
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<AgentTask[], E>,
  };
};

/** For an agent with no farm behind it (the command line): the graph lasts as long as the process. */
export function memoryStore(): AgentTaskStore {
  let g: AgentTask[] = [];
  return {
    load: Effect.sync(() => [...g]),
    change: <E>(f: (g: AgentTask[]) => Effect.Effect<AgentTask[], E>) =>
      Effect.map(f([...g]), (next) => {
        g = finished(next) ? [] : next;
        return next;
      }),
  };
}
