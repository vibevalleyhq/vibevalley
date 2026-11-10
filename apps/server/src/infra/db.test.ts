import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { tempDir } from "@vibevalley/testkit/temp";

import { testDatabase } from "#/testing/layers.ts";
import { lanOpen, setLanOpen } from "#db/lan.sql.ts";
import { addUserDevice, seenUserDevice, userDevices } from "#db/user_device.sql.ts";

import { Db, setAsideStale } from "./db.ts";

describe("the database", () => {
  it.effect("has the schema, and the generated queries run on it", () =>
    Effect.gen(function* () {
      yield* setLanOpen({ open: true });
      expect((yield* lanOpen()).open).toBe(true);
      yield* addUserDevice({ id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1_700_000_000_123 });
      yield* seenUserDevice({ last_seen: 1_700_000_000_456, id: "d1" });
      const devices = yield* userDevices();
      expect(devices).toEqual([{ id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1_700_000_000_123, last_seen: 1_700_000_000_456 }]);
    }).pipe(Effect.provide(testDatabase())),
  );

  it.effect("one is the row, or undefined when there is none; a query that fails is still a defect", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const lanOpen2 = yield* db.one(lanOpen());
      expect(lanOpen2).toBeUndefined();
      yield* db.run(setLanOpen({ open: true }));
      expect((yield* db.one(lanOpen()))?.open).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("drop table lan").pipe(Effect.orDie);
      const failed = yield* Effect.exit(db.one(lanOpen()));
      expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true);
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(testDatabase())))),
  );

  it.effect("a transaction inside a transaction is a savepoint: its rollback keeps the outer work", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.inTx(
        Effect.gen(function* () {
          yield* db.run(addUserDevice({ id: "outer", name: "外层", came: "paired", key_hash: "a", added_at: 1 }));
          const inner = yield* Effect.exit(
            db.attemptTx(Effect.andThen(db.run(addUserDevice({ id: "inner", name: "内层", came: "paired", key_hash: "b", added_at: 2 })), Effect.fail("no"))),
          );
          expect(Exit.isFailure(inner)).toBe(true);
        }),
      );
      expect((yield* db.run(userDevices())).map((d) => d.id)).toEqual(["outer"]);
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(testDatabase())))),
  );

  it.effect("a failed outer transaction keeps none of its work, and the inner work with it", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* Effect.exit(
        db.inTx(
          Effect.gen(function* () {
            yield* db.run(addUserDevice({ id: "outer", name: "外层", came: "paired", key_hash: "a", added_at: 1 }));
            yield* db.inTx(Effect.andThen(db.run(addUserDevice({ id: "inner", name: "内层", came: "paired", key_hash: "b", added_at: 2 })), Effect.void));
            return yield* Effect.fail("no");
          }),
        ),
      );
      const devices = yield* db.run(userDevices());
      expect(devices).toEqual([]);
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(testDatabase())))),
  );

  it.effect("attemptTx keeps the database's failure as a value, and keeps none of the work", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const sql = yield* SqlClient.SqlClient;
      const failed = yield* Effect.flip(db.attemptTx(Effect.andThen(setLanOpen({ open: true }), sql.unsafe("select * from nowhere"))));
      expect(failed._tag).toBe("SqlError");
      const lanOpen2 = yield* db.one(lanOpen());
      expect(lanOpen2).toBeUndefined();
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(testDatabase())))),
  );

  it.effect("every farm in memory has a database of its own, numbered from the start", () => {
    const farm = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{ count: number }>`SELECT count(*) AS count FROM channel_participant`.pipe(Effect.orDie);
      yield* sql`INSERT INTO channel_participant (id, kind, name, joined_at) VALUES ('u', 'user', '用户', 1)`.pipe(Effect.orDie);
      const seq = yield* sql<{ seq: number }>`SELECT seq FROM channel_participant WHERE id = 'u'`.pipe(Effect.orDie);
      return [before[0]!.count, seq[0]!.seq];
    });
    return Effect.gen(function* () {
      for (let n = 0; n < 3; n++) {
        const counts = yield* farm.pipe(Effect.provide(testDatabase()));
        expect(counts).toEqual([0, 1]);
      }
    });
  });

  it.effect("a new database on disk keeps what is written, across a reopen", () => {
    const where = join(tempDir("vibevalley-db-"), "db");
    const open = <A, E>(f: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.orDie(f).pipe(Effect.provide(testDatabase({ db: where })));
    return Effect.gen(function* () {
      yield* open(addUserDevice({ id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1 }));
      expect(readFileSync(where + ".schema", "utf8").trim()).not.toBe("");
      expect(readdirSync(where)).toContain("PG_VERSION");
      const opened = yield* open(userDevices());
      expect(opened).toMatchObject([{ id: "d1", name: "手机" }]);
    });
  });

  it("a database from another baseline is set aside, not deleted; one without a mark is taken as today's", () => {
    const home = tempDir("vibevalley-db-");
    const db = join(home, "db");
    mkdirSync(db);
    expect(setAsideStale(db, "new", 7)).toBeUndefined();
    writeFileSync(db + ".schema", "new\n");
    expect(setAsideStale(db, "new", 7)).toBeUndefined();
    writeFileSync(db + ".schema", "old\n");
    expect(setAsideStale(db, "new", 7)).toBe(db + ".old-7");
    expect(readdirSync(home).toSorted()).toEqual(["db.old-7", "db.old-7.schema"]);
    expect(setAsideStale(db, "new", 8)).toBeUndefined();
  });
});

/** Where a failed query is a value, not a defect (Db.attempt, Db.attemptTx), and why. */
const attempting: Readonly<Record<string, string>> = {
  "channel/talk.ts": "a direct context whose initial delivery cannot be kept is refused as NotRecorded before its events are attached",
  "connector/connector.ts": "a bridge write that fails is shown on the connector's status and tried again",
  "cron/cron.ts": "a cron's run that is not kept is logged, and the next due cron goes on",
  "game/game.ts": "a ledger entry that is not kept is logged, and the farm goes on",
  "issue/lifecycle.ts": "an issue that is not saved, split, edited, or linked to its session or orchestrator is told as a refusal",
  "mailbox/triggers.ts": "the source cursor and trigger commit together; a failed cron input is logged and retried without advancing its clock",
  "mailbox/work.ts":
    "a Session's first direct deliveries are registered atomically; a failed insert is returned so Session startup can stop and report NotRecorded",
  "media/inputs.ts": "a rejected input commit removes its newly published file; failed cleanup retains its tombstone for restart recovery",
  "memory/memory.ts": "a memory read or write that fails is logged and taken as none",
  "session/inProcessRun.ts": "a run write fails as NotRecorded so an in-process run retries its end before accepting another input",
  "session/registry.ts": "a session's own record that is not kept is logged without discarding its live execution",
  "session/session.ts": "a report handed in that cannot be kept is told as a refusal, and the turn does not take it",
};

it("attempt and attemptTx are used only where a failed query is told or retried, each with its reason", () => {
  const src = join(import.meta.dirname, "..");
  const using = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /\bdb\s*\.attempt(?:Tx)?\(/u.test(readFileSync(join(src, f), "utf8")))
    .map((f) => f.split("\\").join("/"))
    .toSorted();
  expect(using).toEqual(Object.keys(attempting).toSorted());
});
