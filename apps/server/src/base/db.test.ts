import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { lanDevices, addLanDevice, seenLanDevice } from "../../db/generated/lan_device.sql.ts";
import { lanOpen, setLanOpen } from "../../db/generated/lan.sql.ts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "../testing/layers.ts";
import { Db, setAsideStale } from "./db.ts";

describe("the database", () => {
  it.effect("has the schema, and the generated queries run on it", () =>
    Effect.gen(function* () {
      yield* setLanOpen({ open: true });
      expect((yield* lanOpen()).open).toBe(true);
      yield* addLanDevice({ id: "d1", name: "手机", key_hash: "h", paired_at: 1_700_000_000_123 });
      yield* seenLanDevice({ last_seen: 1_700_000_000_456, id: "d1" });
      expect(yield* lanDevices()).toEqual([{ id: "d1", name: "手机", key_hash: "h", paired_at: 1_700_000_000_123, last_seen: 1_700_000_000_456 }]);
    }).pipe(Effect.provide(testDatabase())),
  );

  it.effect("one is the row, or undefined when there is none; a query that fails is still a defect", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      expect(yield* db.one(lanOpen())).toBeUndefined();
      yield* db.run(setLanOpen({ open: true }));
      expect((yield* db.one(lanOpen()))?.open).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("drop table lan").pipe(Effect.orDie);
      const failed = yield* Effect.exit(db.one(lanOpen()));
      expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true);
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(testDatabase())))),
  );

  // In memory a farm's database is given back and kept for the next one (db.ts): it must be as good as new.
  it.effect("a database given back is empty for the next farm, its identities from 1 again", () => {
    const seqs = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM channel_participant`.pipe(Effect.orDie);
      yield* sql`INSERT INTO channel_participant (id, kind, name, joined_at) VALUES ('u', 'owner', '主人', 1)`.pipe(Effect.orDie);
      const seq = yield* sql<{ seq: number }>`SELECT seq FROM channel_participant WHERE id = 'u'`.pipe(Effect.orDie);
      return [rows[0]!.count, seq[0]!.seq];
    });
    return Effect.gen(function* () {
      for (let farm = 0; farm < 3; farm++) expect(yield* seqs.pipe(Effect.provide(testDatabase()))).toEqual([0, 1]);
    });
  });

  it.effect("a database whose schema a test changed is not given to the next farm", () =>
    Effect.gen(function* () {
      const functions = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return (yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'left_behind'`.pipe(Effect.orDie))[0]!.n;
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("create function left_behind() returns int language sql as 'select 1'").pipe(Effect.orDie);
        expect(yield* functions).toBe(1);
      }).pipe(Effect.provide(testDatabase()));
      expect(yield* functions.pipe(Effect.provide(testDatabase()))).toBe(0);
    }),
  );

  // A new folder on disk starts from the copy of the baseline the first database in memory left (db.ts).
  it.effect("a new database on disk made from the copy keeps what is written, across a reopen", () => {
    const where = join(mkdtempSync(join(tmpdir(), "vibevalley-db-")), "db");
    const open = (f: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) => Effect.orDie(f).pipe(Effect.provide(testDatabase({ db: where })));
    return Effect.gen(function* () {
      yield* lanDevices().pipe(Effect.provide(testDatabase()), Effect.orDie);
      yield* open(addLanDevice({ id: "d1", name: "手机", key_hash: "h", paired_at: 1 }));
      expect(readFileSync(where + ".schema", "utf8").trim()).not.toBe("");
      expect(yield* open(lanDevices())).toMatchObject([{ id: "d1", name: "手机" }]);
    });
  });

  it("a database from another baseline is set aside, not deleted; one without a mark is taken as today's", () => {
    const home = mkdtempSync(join(tmpdir(), "vibevalley-db-"));
    const db = join(home, "db");
    mkdirSync(db);
    expect(setAsideStale(db, "new", 7)).toBeUndefined();
    writeFileSync(db + ".schema", "new\n");
    expect(setAsideStale(db, "new", 7)).toBeUndefined();
    writeFileSync(db + ".schema", "old\n");
    expect(setAsideStale(db, "new", 7)).toBe(db + ".old-7");
    expect(readdirSync(home).sort()).toEqual(["db.old-7", "db.old-7.schema"]);
    expect(setAsideStale(db, "new", 8)).toBeUndefined();
  });
});

/** Where a failed query is a value, not a defect (Db.attempt), and why. */
const attempting: Readonly<Record<string, string>> = {
  "connector/connector.ts": "a bridge write that fails is shown on the connector's status and tried again",
  "game/game.ts": "a ledger entry that is not kept is logged, and the farm goes on",
  "memory/memories.ts": "a memory read or write that fails is logged and taken as none",
};

it("attempt is used only where a failed query is told or retried, each with its reason", () => {
  const src = join(import.meta.dirname, "..");
  const using = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /\{[^}]*\battempt\b[^}]*\}\s*=\s*yield\*\s*Db\b|\bDb\b[^;]*\.attempt\(/.test(readFileSync(join(src, f), "utf8")))
    .map((f) => f.split("\\").join("/"))
    .sort();
  expect(using).toEqual(Object.keys(attempting).sort());
});
