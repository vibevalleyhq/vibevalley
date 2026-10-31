// The agents' own todos (packages/agent todo.ts) in the farm's database, table runtime_todo, one open graph per keeper
// (a session of the vibevalley runtime).

import { Clock, Effect, Schema } from "effect";

import { toolFailed } from "@vibevalley/agent/core/errors";
import { finished, type Todo } from "@vibevalley/agent/todo";
import type { TodoStore } from "@vibevalley/agent/todoStore";

import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { Db } from "@/infra/db.ts";

import * as q from "../../db/generated/runtime_todo.sql.ts";

const afterOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const fromRow = (r: q.OpenTodosResult): Todo => ({
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
export const dbTodoStores: Effect.Effect<(keeper: string) => TodoStore, never, Db> = Effect.gen(function* () {
  const db = yield* Db;
  return (keeper) => ({
    load: Effect.map(db.run(q.openTodos({ keeper })), (rows) => rows.map(fromRow)),
    change: <G extends Todo[] | undefined>(f: (g: Todo[]) => G) =>
      db.inTx(
        Effect.gen(function* () {
          const rows = yield* db.run(q.openTodos({ keeper }));
          const g = yield* Effect.try({ try: () => f(rows.map(fromRow)), catch: toolFailed });
          if (g === undefined) return g;
          // The graph keeps its id while it is open; a new one starts when the keeper had none.
          const graph = rows[0]?.graph ?? newId();
          yield* db.run(q.clearOpenTodos({ keeper }));
          const at = yield* Clock.currentTimeMillis;
          yield* Effect.forEach(
            g.entries(),
            ([position, t]) =>
              db.run(
                q.addTodo({
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
              ),
            { discard: true },
          );
          if (finished(g)) yield* db.run(q.finishTodos({ finished_at: at, keeper }));
          return g;
        }),
      ),
  });
});
