import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { testDatabase } from "../../testing/layers.ts";
import { add, begin, type Change, finished, readyTasks, requeue, settle, type Task, TaskError, text, update } from "./taskGraph.ts";
import { dbStore, memoryStore, type TaskStore } from "./taskStore.ts";
import * as q from "../../../db/generated/agent_task.sql.ts";

const ids = (g: readonly Task[]) => g.map((t) => t.id);

const three = () => {
  const [g, problems] = add(
    [],
    [
      { id: "read", brief: "读 auth 的代码" },
      { id: "fix", brief: "改 token 过期的判断", after: ["read"] },
      { id: "test", brief: "跑 auth 的测试", after: ["fix"] },
    ],
  );
  expect(problems).toEqual([]);
  return g;
};

describe("an agent's task graph", () => {
  it("added tasks wait, and the first is ready", () => {
    const g = three();
    expect(ids(readyTasks(g))).toEqual(["read"]);
    expect([g[0]!.by, g[0]!.title, g[0]!.after]).toEqual(["self", "读 auth 的代码", []]);
  });

  it("a batch with any problem changes nothing", () => {
    const g = three();
    for (const [more, want] of [
      [[{ id: "read", brief: "再读一遍" }], "id「read」重复了"],
      [[{ id: "x", brief: "b", after: ["x"] }], "「x」不能等自己"],
      [[{ id: "x", brief: "b", after: ["nope"] }], "「x」要等的「nope」不存在"],
      [[{ id: "读代码", brief: "b" }], "不能当 id"],
      [[{ id: "x" }], "没有写要做什么"],
      [[], "一件任务都没有"],
    ] as const) {
      const [next, problems] = add(g, more as never);
      expect(problems.join("；")).toContain(want);
      expect(ids(next)).toEqual(ids(g));
    }
    expect(
      add(
        [],
        [
          { id: "a", brief: "b", after: ["b"] },
          { id: "b", brief: "b", after: ["a"] },
        ],
      )[1],
    ).toEqual(["这几件互相等，成了一个圈：a、b"]);
  });

  it("done or skipped lets the next start", () => {
    let g = update(three(), "read", { state: "done", result: "token 在 auth/jwt.go 里判断" });
    expect(ids(readyTasks(g))).toEqual(["fix"]);
    g = update(g, "fix", { state: "skipped" });
    expect(ids(readyTasks(g))).toEqual(["test"]);
    expect(finished(g)).toBe(false);
    expect(finished(update(g, "test", { state: "done" }))).toBe(true);
  });

  it("what a task may become", () => {
    let g = update(three(), "read", { state: "failed", result: "没权限读" });
    g = update(g, "read", { state: "waiting", brief: "用 sudo 读" });
    expect([g[0]!.tries, g[0]!.brief]).toEqual([1, "用 sudo 读"]);
    g = update(g, "read", { state: "done" });
    expect(() => update(g, "read", { brief: "再读" })).toThrow(/做完了/);
    expect(() => update(g, "read", { state: "waiting" })).toThrow(TaskError);
    expect(() => update(g, "nope", { state: "done" } as Change)).toThrow(TaskError);
    expect(() => update(g, "fix", { after: ["test"] })).toThrow(/成了一个圈/);
  });

  it("the graph as the model reads it", () => {
    const g = update(three(), "read", { state: "done", result: "在\n  jwt.go" });
    expect(text(g)).toBe(
      [
        "任务（3 件，1 件可以做）：",
        "- [做完了] read 读 auth 的代码 → 在 jwt.go",
        "- [可以做] fix 改 token 过期的判断（等 read）",
        "- [等着] test 跑 auth 的测试（等 fix）",
      ].join("\n"),
    );
    expect(text([])).toBe("现在没有任务。");
  });

  it("a helper's task goes out and comes back", () => {
    let [g] = add(
      [],
      [
        { id: "a", brief: "查 A", by: "helper" },
        { id: "b", brief: "查 B", by: "helper", after: ["a"] },
      ],
    );
    g = begin(g, "a");
    expect([g[0]!.state, readyTasks(g).length]).toEqual(["working", 0]);
    g = settle(g, "a", "超时了", true);
    expect([g[0]!.state, g[0]!.tries]).toEqual(["waiting", 1]);
    g = settle(begin(g, "a"), "a", "还是超时", true);
    expect(g[0]!.state).toBe("failed");
    g = update(g, "a", { state: "waiting" });
    g = settle(begin(g, "a"), "a", "A 在 x.go", false);
    expect([g[0]!.state, g[0]!.result, ids(readyTasks(g))]).toEqual(["done", "A 在 x.go", ["b"]]);
    expect(requeue(begin(g, "b"), ["b"])[1]!.state).toBe("waiting");
  });

  const stores = Effect.map(
    SqlClient.SqlClient,
    (sql) =>
      ({
        database: (owner: string) => dbStore(sql, owner),
        memory: (_: string) => memoryStore(),
      }) as Record<string, (owner: string) => TaskStore>,
  );

  it.effect("a store keeps the graph and puts a finished one away", () =>
    Effect.gen(function* () {
      for (const [name, open] of Object.entries(yield* stores)) {
        const s = open("s1");
        const g = yield* s.change((g) =>
          Effect.succeed(
            add(g, [
              { id: "a", brief: "b" },
              { id: "c", brief: "d", after: ["a"], by: "helper" },
            ])[0],
          ),
        );
        expect(yield* s.load, name).toEqual(g);
        expect((yield* Effect.exit(s.change(() => Effect.fail("不改了"))))._tag, name).toBe("Failure");
        expect(yield* s.load, name).toEqual(g);
        const ended = yield* s.change((g) => Effect.succeed(update(update(g, "a", { state: "done" }), "c", { state: "skipped" })));
        expect(finished(ended), name).toBe(true);
        expect(yield* s.load, name).toEqual([]);
      }
    }).pipe(Effect.provide(testDatabase())),
  );

  it.effect("a database store decodes task dependencies before using them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, position, after] of [
        ["bad", 0, `{}`],
        ["good", 1, `["bad"]`],
      ] as const)
        yield* Effect.orDie(
          q.addGraphTask({
            graph: "g1",
            owner: "s1",
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
      const got = yield* dbStore(sql, "s1").load;
      expect(got.map((t) => [t.id, t.after])).toEqual([
        ["bad", []],
        ["good", ["bad"]],
      ]);
    }).pipe(Effect.provide(testDatabase())),
  );

  it.effect("one owner's graph is not another's", () =>
    Effect.gen(function* () {
      const open = (yield* stores).database!;
      yield* open("s1").change((g) => Effect.succeed(add(g, [{ id: "a", brief: "b" }])[0]));
      expect(yield* open("s2").load).toEqual([]);
    }).pipe(Effect.provide(testDatabase())),
  );
});
