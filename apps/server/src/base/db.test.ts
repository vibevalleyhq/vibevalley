import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Schema, SchemaIssue } from "effect";
import { SqlError } from "effect/sql";
import { lanDevices, addLanDevice, seenLanDevice } from "../../db/generated/lan_device.sql.ts";
import { lanOpen, setLanOpen } from "../../db/generated/lan.sql.ts";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "../testing/layers.ts";
import { optional, setAsideStale } from "./db.ts";

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

  it.effect("makes a missing row none and keeps a row", () =>
    Effect.gen(function* () {
      const missing = yield* optional(Effect.fail(new Cause.NoSuchElementError()));
      const row = yield* optional(Effect.succeed({ id: "d1" }));
      expect(missing).toEqual(Option.none());
      expect(row).toEqual(Option.some({ id: "d1" }));
    }),
  );

  it.effect("keeps SQL and schema failures", () =>
    Effect.gen(function* () {
      const sql = new SqlError.SqlError({ reason: new SqlError.SqlSyntaxError({ message: "bad sql", cause: undefined }) });
      const schema = new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "bad row" }));
      const sqlFailure = yield* Effect.flip(optional(Effect.fail(sql)));
      const schemaFailure = yield* Effect.flip(optional(Effect.fail(schema)));
      expect(sqlFailure).toBe(sql);
      expect(schemaFailure).toBe(schema);
    }),
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
