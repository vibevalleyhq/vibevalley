import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import { add, finished, TodoError, update } from "@vibevalley/agent/todo";
import { memoryStore } from "@vibevalley/agent/todoStore";

import { Db } from "#/infra/db.ts";
import { testDatabase } from "#/testing/layers.ts";
import * as q from "#db/runtime_todo.sql.ts";

import { dbTodoStores } from "./vibevalley.ts";

describe("an agent's own todos, kept", () => {
  const database = Layer.provideMerge(Db.layer, testDatabase());
  const stores = Effect.map(dbTodoStores, (database) => ({ database, memory: (_: string) => memoryStore() }));

  it.effect("a store keeps the graph and puts a finished one away", () =>
    Effect.gen(function* () {
      const todoStores = yield* stores;
      for (const [name, open] of Object.entries(todoStores)) {
        const s = open("s1");
        const g = yield* s.change(
          (g) =>
            add(g, [
              { id: "a", brief: "b" },
              { id: "c", brief: "d", after: ["a"], by: "subagent" },
            ])[0],
        );
        const load2 = yield* s.load;
        expect(load2, name).toEqual(g);
        const refused = yield* Effect.flip(
          s.change(() => {
            throw TodoError.make({ message: "不改了" });
          }),
        );
        expect(refused, name).toMatchObject({ _tag: "ToolFailed", message: "不改了" });
        expect(refused.cause, name).toBeInstanceOf(TodoError);
        const change2 = yield* s.change(() => undefined);
        expect(change2, name).toBeUndefined();
        const load3 = yield* s.load;
        expect(load3, name).toEqual(g);
        const ended = yield* s.change((g) => update(update(g, "a", { state: "done" }), "c", { state: "skipped" }));
        expect(finished(ended), name).toBe(true);
        const load4 = yield* s.load;
        expect(load4, name).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("a database store fails fast on task dependencies that are not a list", () =>
    Effect.gen(function* () {
      for (const [id, position, after] of [
        ["bad", 0, `{}`],
        ["good", 1, `["bad"]`],
      ] as const)
        yield* Effect.orDie(
          q.addTodo({
            graph: "g1",
            keeper: "s1",
            id,
            position,
            title: "",
            brief: "",
            after,
            executor: "self",
            state: "waiting",
            result: "",
            tries: 0,
            updated_at: 0,
          }),
        );
      const loaded = yield* Effect.exit((yield* dbTodoStores)("s1").load);
      expect(Exit.isFailure(loaded) ? Cause.pretty(loaded.cause) : "loaded").toContain("runtime_todo.after");
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("one keeper's tasks are not another's", () =>
    Effect.gen(function* () {
      const open = yield* dbTodoStores;
      yield* open("s1").change((g) => add(g, [{ id: "a", brief: "b" }])[0]);
      const loaded = yield* open("s2").load;
      expect(loaded).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(database)),
  );
});
