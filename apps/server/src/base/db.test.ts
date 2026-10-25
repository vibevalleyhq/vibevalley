import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { lanDevices, addLanDevice, seenLanDevice } from "../../db/generated/lan_device.sql.ts";
import { lanOpen, setLanOpen } from "../../db/generated/lan.sql.ts";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "../testing/layers.ts";
import { Db, DbLayer, setAsideStale } from "./db.ts";

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
    }).pipe(Effect.provide(DbLayer.pipe(Layer.provideMerge(testDatabase())))),
  );

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
