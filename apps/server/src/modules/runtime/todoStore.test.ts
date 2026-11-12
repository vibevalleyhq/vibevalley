import { describe, expect, test } from "vite-plus/test";

import { add, finished, TodoError, update } from "@vibevalley/agent/todo";
import { memoryStore } from "@vibevalley/agent/todoStore";

import { openDb } from "#/infra/db.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { testConfig } from "#/testing/layers.ts";
import * as q from "#db/runtime_todo.sql.ts";

import { dbTodoStores } from "./vibevalley.ts";

const database = async () => {
  const db = await openDb(testConfig(), keptLog(), wallTime);
  return Object.assign(db, { stores: dbTodoStores({ db, clock: wallTime }) });
};

describe("an agent's own todos, kept", () => {
  test("a store keeps the graph and puts a finished one away", async () => {
    await using db = await database();
    const todoStores = { database: db.stores, memory: (_: string) => memoryStore() };
    for (const [name, open] of Object.entries(todoStores)) {
      const s = open("s1");
      const g = await s.change(
        (g) =>
          add(g, [
            { id: "a", brief: "b" },
            { id: "c", brief: "d", after: ["a"], by: "subagent" },
          ])[0],
      );
      const load2 = await s.load();
      expect(load2, name).toEqual(g);
      const refused = await s
        .change(() => {
          throw new TodoError("不改了");
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(refused, name).toMatchObject({ _tag: "ToolFailed", message: "不改了" });
      expect(refused instanceof Error ? refused.cause : undefined, name).toBeInstanceOf(TodoError);
      const change2 = await s.change(() => undefined);
      expect(change2, name).toBeUndefined();
      const load3 = await s.load();
      expect(load3, name).toEqual(g);
      const ended = await s.change((g) => update(update(g, "a", { state: "done" }), "c", { state: "skipped" }));
      expect(finished(ended), name).toBe(true);
      const load4 = await s.load();
      expect(load4, name).toEqual([]);
    }
  });

  test("a database store fails fast on task dependencies that are not a list", async () => {
    await using db = await database();
    for (const [id, position, after] of [
      ["bad", 0, `{}`],
      ["good", 1, `["bad"]`],
    ] as const)
      await q.addTodo(db.sql, {
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
      });
    const loaded = await db
      .stores("s1")
      .load()
      .then(
        () => "loaded",
        (e: unknown) => String(e),
      );
    expect(loaded).toContain("runtime_todo.after");
  });

  test("one keeper's tasks are not another's", async () => {
    await using db = await database();
    await db.stores("s1").change((g) => add(g, [{ id: "a", brief: "b" }])[0]);
    const loaded = await db.stores("s2").load();
    expect(loaded).toEqual([]);
  });
});
