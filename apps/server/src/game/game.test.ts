import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Session } from "@vibevalley/protocol";
import { playOf, sessionOf } from "@vibevalley/protocol/rules";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Core } from "../core/core.ts";
import { gitSync, repo } from "../testing/git.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { Game, layer } from "./game.ts";

const farm = (config = testConfig()) => layer.pipe(Layer.provideMerge(world({ config })));

const kinds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Effect.orDie(sql<{ kind: string }>`select kind from game_ledger order by id`);
  return rows.map((r) => r.kind);
});

const until = <A, R>(get: Effect.Effect<A, never, R>, ok: (a: A) => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      const got = yield* get;
      if (ok(got)) return got;
      yield* Effect.sleep(10);
    }
    throw new Error(`waited for ${what}`);
  });

const helper = (id: string, phase = { _tag: "working", since: 0, doing: { action: "thinking", label: "" } } as Session["phase"]) =>
  ({ id, name: id, agent: "lab", runtime: "pi", brief: "试试", hiredAt: 0, runs: 0, phase }) as Session;

describe("the game", () => {
  it.live("keeps a ledger the progress folds back from", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      const before = yield* Effect.gen(function* () {
        const game = yield* Game;
        const core = yield* Core;
        yield* game.record({ kind: "harvested", session: "w1", agent: "lab", project: "demo", runtime: "pi", commits: 1, runs: 1 });
        const p = core.state().progress!;
        expect(p.coins).toBeGreaterThanOrEqual(35);
        expect(p.counts.harvests).toBe(1);
        yield* core.apply({ type: "hired", session: helper("w2") });
        yield* core.apply({ type: "report", id: "w2", outcome: "failed", summary: "坏了", runs: 1 });
        yield* core.apply({ type: "commits", commits: { total: 1000, repos: [] } });
        yield* until(kinds, (k) => k.join() === "harvested,hired,failed,level", "the ledger");
        return core.state().progress!;
      }).pipe(Effect.scoped, Effect.provide(farm(config)));
      yield* Effect.gen(function* () {
        const core = yield* Core;
        expect(core.state().progress).toEqual(before);
        // A level already on the ledger is not told again.
        expect((yield* kinds).at(-1)).toBe("level");
      }).pipe(Effect.scoped, Effect.provide(farm(config)));
    });
  });

  // What the owner did reaches the ledger from the service it went through, whatever the entry point.
  it.live("counts the owner's review and call", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* Effect.sleep(10);
      yield* core.did({ kind: "reviewed", session: "w1" });
      yield* core.did({ kind: "talked" });
      yield* until(kinds, (k) => [...k].sort().join() === "reviewed,voice", "both");
    }).pipe(Effect.scoped, Effect.provide(farm())),
  );

  it.live("counts a session's commits once per repository", () => {
    const config = testConfig();
    const app = join(config.workRoot, "projects", "app");
    repo(app, 3, 2);
    const tree = join(config.workRoot, "worktrees", "w1");
    gitSync(app, "worktree", "add", "-q", "-b", "vibevalley/w1", tree);
    gitSync(tree, "commit", "-q", "--allow-empty", "-m", "session work");
    repo(join(config.workRoot, "projects", "tools", "cli"), 1, 0);
    return Effect.gen(function* () {
      const game = yield* Game;
      const count = yield* game.count();
      // The worktree is not a second repository; 3 + 1 on the worktree branch in app, 1 in cli; the colleague's 2 do not count.
      expect(count.repos.length).toBe(2);
      expect(count.total).toBe(5);
      expect(count.repos.map((r) => r.commits).sort((a, b) => a - b)).toEqual([1, 4]);
    }).pipe(Effect.scoped, Effect.provide(farm(config)));
  });

  it.live("puts the next helper on the planted plot", () =>
    Effect.gen(function* () {
      const game = yield* Game;
      const core = yield* Core;
      const stationOf = (id: string) =>
        Effect.sync(() => {
          const h = sessionOf(core.state(), id);
          return h ? playOf(h).station : -2;
        });
      const arriving = { _tag: "arriving" } as Session["phase"];
      yield* Effect.sleep(10);
      game.want(4);
      yield* core.apply({ type: "hired", session: helper("w1", arriving) });
      yield* until(stationOf("w1"), (s) => s === 4, "w1 on station 4");
      yield* core.apply({ type: "hired", session: helper("w2", arriving) });
      yield* until(stationOf("w2"), (s) => s === 0, "w2 on the first free station");
      game.want(4);
      yield* core.apply({ type: "hired", session: helper("w3", arriving) });
      yield* until(stationOf("w3"), (s) => s >= 0, "w3 hired");
      yield* core.apply({ type: "hired", session: helper("w4", arriving) });
      yield* until(stationOf("w4"), (s) => s >= 0, "w4 hired");
      expect(yield* stationOf("w1")).toBe(4);
      // A taken station is not given again, and the wish is used once.
      expect([yield* stationOf("w3"), yield* stationOf("w4")]).toEqual([1, 2]);
    }).pipe(Effect.scoped, Effect.provide(farm())),
  );
});
