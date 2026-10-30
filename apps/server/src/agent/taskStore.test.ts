import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { add, finished, AgentTaskError, update } from "@vibevalley/agent/agentTask";
import { memoryStore } from "@vibevalley/agent/agentTaskStore";

import { Db } from "@/base/db.ts";
import { testDatabase } from "@/testing/layers.ts";

import * as q from "../../db/generated/agent_task.sql.ts";
import { dbStores } from "./taskStore.ts";

describe("an agent's own tasks, kept", () => {
  const database = Layer.provideMerge(Db.layer, testDatabase());
  const stores = Effect.map(dbStores, (database) => ({ database, memory: (_: string) => memoryStore() }));

  it.effect("a store keeps the graph and puts a finished one away", () =>
    Effect.gen(function* () {
      for (const [name, open] of Object.entries(yield* stores)) {
        const s = open("s1");
        const g = yield* s.change(
          (g) =>
            add(g, [
              { id: "a", brief: "b" },
              { id: "c", brief: "d", after: ["a"], by: "subagent" },
            ])[0],
        );
        expect(yield* s.load, name).toEqual(g);
        const refused = yield* Effect.flip(
          s.change(() => {
            throw new AgentTaskError({ message: "不改了" });
          }),
        );
        expect(refused, name).toMatchObject({ _tag: "ToolFailed", message: "不改了" });
        expect(refused.cause, name).toBeInstanceOf(AgentTaskError);
        expect(yield* s.change(() => undefined), name).toBeUndefined();
        expect(yield* s.load, name).toEqual(g);
        const ended = yield* s.change((g) => update(update(g, "a", { state: "done" }), "c", { state: "skipped" }));
        expect(finished(ended), name).toBe(true);
        expect(yield* s.load, name).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("a database store decodes task dependencies before using them", () =>
    Effect.gen(function* () {
      for (const [id, position, after] of [
        ["bad", 0, `{}`],
        ["good", 1, `["bad"]`],
      ] as const)
        yield* Effect.orDie(
          q.addAgentTask({
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
      const got = yield* (yield* dbStores)("s1").load;
      expect(got.map((t) => [t.id, t.after])).toEqual([
        ["bad", []],
        ["good", ["bad"]],
      ]);
    }).pipe(Effect.scoped, Effect.provide(database)),
  );

  it.effect("one keeper's tasks are not another's", () =>
    Effect.gen(function* () {
      const open = yield* dbStores;
      yield* open("s1").change((g) => add(g, [{ id: "a", brief: "b" }])[0]);
      expect(yield* open("s2").load).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(database)),
  );
});
