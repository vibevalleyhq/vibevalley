import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { Repo as RepoRecord, Session } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { sessionOf } from "#/modules/session/roster.ts";
import { gitSync, repo } from "#/testing/git.ts";
import { testConfig, waitFor as until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as q from "#db/game_ledger.sql.ts";

import { makeGame } from "./game.ts";
import { playOf } from "./view.ts";

/** The world with the game on it (the world has none); repo stands in for the farm's when given. */
async function farm(config: ServerConfig = testConfig(), repoOf?: (current: Repo) => Repo) {
  const below = await world({ config });
  const game = await makeGame({
    config,
    clock: below.clock,
    log: below.log,
    db: below.db,
    core: below.core,
    repo: repoOf ? repoOf(below.repo) : below.repo,
  });
  return {
    ...below,
    game,
    async [Symbol.asyncDispose]() {
      await game.close();
      await below.close();
    },
  };
}

const kinds = (f: { readonly db: Db }) => async () => (await f.db.sql.query("select kind from game_ledger order by id")).map((r) => String(r["kind"]));

/** Enough turns for what a settled promise sets off to run. */
const turns = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

const helper = (id: string, phase: Session["phase"] = { _tag: "working", since: 0, doing: { action: "thinking", label: "" } }): Session => ({
  id: sessionId(id),
  role: "worker",
  name: id,
  agent: "lab",
  runtime: "pi",
  brief: "试试",
  hiredAt: 0,
  runs: 0,
  phase,
  refining: false,
});

describe("the game", () => {
  test("keeps a ledger the progress folds back from", async () => {
    const config = { ...testConfig(), db: "" };
    let before: unknown;
    {
      await using f = await farm(config);
      const { game, core } = f;
      await game.record({ kind: "harvested", session: sessionId("w1"), agent: "lab", repo: "demo", runtime: "pi", commits: 1, runs: 1 });
      const p = core.state().progress!;
      expect(p.coins).toBeGreaterThanOrEqual(35);
      expect(p.counts.harvests).toBe(1);
      core.apply({ type: "sessionChanged", session: helper("w2") });
      core.apply({
        type: "sessionReported",
        questions: [],
        checks: [],
        id: sessionId("w2"),
        outcome: "failed",
        summary: "坏了",
        runs: 1,
      });
      core.apply({ type: "progressChanged", commits: { total: 1000, repos: [] } });
      await until(kinds(f), (k) => k.join() === "harvested,hired,failed,level", "the ledger");
      before = core.state().progress!;
    }
    {
      await using f = await farm(config);
      expect(f.core.state().progress).toEqual(before);
      // A level already on the ledger is not told again.
      expect((await kinds(f)()).at(-1)).toBe("level");
    }
  });

  test("malformed and infinite ledger entries stay out of the fold", async () => {
    const config = { ...testConfig(), db: "" };
    {
      await using f = await farm(config);
      const sql = f.db.sql;
      await q.addLedgerEntry(sql, {
        id: "bad-infinity",
        kind: "harvested",
        at: 1,
        payload: `{"session":"bad","repo":"demo","runtime":"pi","commits":1e999,"runs":1}`,
      });
      await q.addLedgerEntry(sql, { id: "bad-shape", kind: "level", at: 2, payload: `{"level":"high"}` });
      await q.addLedgerEntry(sql, { id: "good", kind: "harvested", at: 3, payload: `{"session":"good","repo":"demo","runtime":"pi","commits":1,"runs":1}` });
    }
    {
      await using f = await farm(config);
      const progress = f.core.state().progress!;
      expect(progress.counts.harvests).toBe(1);
      expect(Number.isFinite(progress.coins)).toBe(true);
      expect(progress.coins).toBeGreaterThan(0);
    }
  });

  // What the user did reaches the ledger from the service it went through, whatever the entry point.
  test("counts the user's review and call", async () => {
    await using f = await farm();
    const { core } = f;
    // The game hears the user from its start: Core.user is subscribed before makeGame returns.
    core.did({ kind: "reviewed", session: sessionId("w1") });
    core.did({ kind: "talked" });
    await until(kinds(f), (k) => [...k].toSorted().join() === "reviewed,voice", "both");
  });

  test("counts a session's commits once per repository", async () => {
    const config = testConfig();
    const app = join(config.workRoot, "repos", "app");
    repo(app, 3, 2);
    const tree = join(config.workRoot, "worktrees", "w1");
    gitSync(app, "worktree", "add", "-q", "-b", "vibevalley/w1", tree);
    gitSync(tree, "commit", "-q", "--allow-empty", "-m", "session work");
    repo(join(config.workRoot, "repos", "tools", "cli"), 1, 0);
    await using f = await farm(config);
    const count = await f.game.count();
    // The worktree is not a second repository. 3 + 1 on the worktree branch in app, 1 in cli.
    expect(count.repos.length).toBe(2);
    expect(count.total).toBe(5);
    expect(count.repos.map((r) => r.commits).toSorted((a, b) => a - b)).toEqual([1, 4]);
  });

  test("puts the next helper on the planted plot", async () => {
    await using f = await farm();
    const { game, core } = f;
    const stationOf = (id: string) => async () => {
      const h = sessionOf(core.state(), id);
      return h ? playOf(core.state().plays, id).station : -2;
    };
    const starting: Session["phase"] = { _tag: "working", since: 0, doing: { action: "none", label: "" } };
    game.want(4);
    core.apply({ type: "sessionChanged", session: helper("w1", starting) });
    await until(stationOf("w1"), (s) => s === 4, "w1 on station 4");
    core.apply({ type: "sessionChanged", session: helper("w2", starting) });
    await until(stationOf("w2"), (s) => s === 0, "w2 on the first free station");
    game.want(4);
    core.apply({ type: "sessionChanged", session: helper("w3", starting) });
    await until(stationOf("w3"), (s) => s >= 0, "w3 hired");
    core.apply({ type: "sessionChanged", session: helper("w4", starting) });
    await until(stationOf("w4"), (s) => s >= 0, "w4 hired");
    const stationOf2 = await stationOf("w1")();
    expect(stationOf2).toBe(4);
    // A taken station is not given again, and the wish is used once.
    expect([await stationOf("w3")(), await stationOf("w4")()]).toEqual([1, 2]);
  });

  test("a slow old commit count cannot overwrite a newer one in either completion order", async () => {
    for (const secondFirst of [false, true]) {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      let calls = 0;
      const contributions = async (): Promise<RepoRecord[]> => {
        calls++;
        if (calls === 1) return first.promise.then(() => [{ path: "old", commits: 1 }]);
        if (calls === 2) return second.promise.then(() => [{ path: "new", commits: 2 }]);
        return [];
      };
      const config = testConfig();
      {
        await using f = await farm(config, (current) => ({ ...current, contributions }));
        await f.game.boot();
        const { core } = f;
        core.apply({ type: "sessionChanged", session: helper("w1") });
        core.apply({
          type: "sessionReported",
          questions: [],
          checks: [],
          id: sessionId("w1"),
          outcome: "failed",
          summary: "",
          runs: 1,
        });
        await turns();
        await vi.advanceTimersByTimeAsync(15_000);
        if (secondFirst) {
          second.resolve();
          await turns();
          first.resolve();
          await turns();
          expect(core.state().commits?.total).toBe(2);
        } else {
          first.resolve();
          await turns();
          expect(core.state().commits?.total).toBe(1);
          second.resolve();
          await turns();
          expect(core.state().commits?.total).toBe(2);
        }
      }
      vi.useRealTimers();
    }
  });
});
