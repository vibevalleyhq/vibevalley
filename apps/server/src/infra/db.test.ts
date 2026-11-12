import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { systemClock } from "@vibevalley/async";
import { tempDir } from "@vibevalley/testkit/temp";

import { lanOpen, setLanOpen } from "#db/lan.sql.ts";
import { addUserDevice, seenUserDevice, userDevices } from "#db/user_device.sql.ts";

import { defaults } from "./config.ts";
import { type Db, dbQueries, openDb, setAsideStale, SqlError } from "./db.ts";
import { keptLog } from "./log.ts";

const open = (db = "memory") => openDb({ ...defaults(tempDir("vibevalley-db-home-")), db }, keptLog(), systemClock);
const device = (id: string, added_at: number) => ({ id, name: id, came: "paired" as const, key_hash: `h-${id}`, added_at });

describe("the database", () => {
  test("has the schema, and the generated queries run on it", async () => {
    await using db = await open();
    await setLanOpen(db.sql, { open: true });
    expect((await lanOpen(db.sql))?.open).toBe(true);
    await addUserDevice(db.sql, { id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1_700_000_000_123 });
    await seenUserDevice(db.sql, { last_seen: 1_700_000_000_456, id: "d1" });
    expect(await userDevices(db.sql)).toEqual([
      { id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1_700_000_000_123, last_seen: 1_700_000_000_456 },
    ]);
  });

  test("one is the row, or undefined when there is none; a query that fails throws", async () => {
    await using db = await open();
    expect(await lanOpen(db.sql)).toBeUndefined();
    await setLanOpen(db.sql, { open: true });
    expect((await lanOpen(db.sql))?.open).toBe(true);
    await db.sql.exec("drop table lan");
    await expect(lanOpen(db.sql)).rejects.toBeInstanceOf(SqlError);
  });

  test("a transaction inside a transaction is a savepoint: its rollback keeps the outer work", async () => {
    await using db = await open();
    await db.tx(async () => {
      await addUserDevice(db.sql, device("outer", 1));
      await expect(
        db.tx(async () => {
          await addUserDevice(db.sql, device("inner", 2));
          throw new Error("no");
        }),
      ).rejects.toThrow("no");
    });
    expect((await userDevices(db.sql)).map((d) => d.id)).toEqual(["outer"]);
  });

  test("a failed outer transaction keeps none of its work, and the inner work with it", async () => {
    await using db = await open();
    await expect(
      db.tx(async () => {
        await addUserDevice(db.sql, device("outer", 1));
        await db.tx(() => addUserDevice(db.sql, device("inner", 2)));
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(await userDevices(db.sql)).toEqual([]);
  });

  test("a failed query in a transaction throws SqlError, each query is counted, and none of the work is kept", async () => {
    await using db = await open();
    const before = dbQueries.count();
    await db.tx(async () => {
      await addUserDevice(db.sql, device("m1", 1));
      await seenUserDevice(db.sql, { last_seen: 2, id: "m1" });
    });
    expect(dbQueries.count() - before).toBe(2);
    const failed = await db
      .tx(async () => {
        await setLanOpen(db.sql, { open: true });
        await db.sql.query("select * from nowhere");
      })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(SqlError);
    expect(await lanOpen(db.sql)).toBeUndefined();
  });

  test("afterCommit runs once the outermost transaction commits, and drops hooks from rolled-back savepoints or transactions", async () => {
    await using db = await open();
    const seen: string[] = [];
    await db.tx(async () => {
      await addUserDevice(db.sql, device("outer", 1));
      await db.afterCommit(() => void seen.push("outer"));
      await db
        .tx(async () => {
          await addUserDevice(db.sql, device("rolled", 2));
          await db.afterCommit(() => void seen.push("rolled"));
          throw new Error("abort-inner");
        })
        .catch(() => undefined);
      await db.tx(async () => {
        await addUserDevice(db.sql, device("inner", 3));
        await db.afterCommit(() => void seen.push("inner"));
      });
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["outer", "inner"]);
    await db
      .tx(async () => {
        await db.afterCommit(() => void seen.push("aborted-outer"));
        throw new Error("abort-outer");
      })
      .catch(() => undefined);
    expect(seen).toEqual(["outer", "inner"]);
  });

  test("a hook after the commit can query the database, and a statement outside waits for a transaction to end", async () => {
    await using db = await open();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tx = db.tx(async () => {
      await addUserDevice(db.sql, device("a", 1));
      await db.afterCommit(async () => void order.push(`hook sees ${(await userDevices(db.sql)).length}`));
      await held;
      order.push("tx done");
    });
    const outside = userDevices(db.sql).then((ds) => void order.push(`outside sees ${ds.length}`));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([tx, outside]);
    expect(order).toEqual(["tx done", "outside sees 1", "hook sees 1"]);
  });

  test("every farm in memory has a database of its own, numbered from the start", async () => {
    for (let n = 0; n < 3; n++) {
      await using db: Db = await open();
      const before = await db.sql.query("select count(*)::int as count from channel_participant");
      await db.sql.exec("insert into channel_participant (id, kind, name, joined_at) values ('u', 'user', '用户', 1)");
      const seq = await db.sql.query("select seq from channel_participant where id = 'u'");
      expect([before[0]?.["count"], seq[0]?.["seq"]]).toEqual([0, 1]);
    }
  });

  test("a new database on disk keeps what is written, across a reopen", async () => {
    const where = join(tempDir("vibevalley-db-"), "db");
    {
      await using db = await open(where);
      await addUserDevice(db.sql, { id: "d1", name: "手机", came: "paired", key_hash: "h", added_at: 1 });
    }
    expect(readFileSync(where + ".schema", "utf8").trim()).not.toBe("");
    expect(readdirSync(where)).toContain("PG_VERSION");
    await using reopened = await open(where);
    expect(await userDevices(reopened.sql)).toMatchObject([{ id: "d1", name: "手机" }]);
  });

  test("a database from another baseline is set aside, not deleted; one without a mark is taken as today's", () => {
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

/** Where a failed query is told or retried rather than a defect (a `catch` that tells SqlError apart), and why. */
const catching: Readonly<Record<string, string>> = {
  "modules/channel/store.ts": "a direct context whose initial delivery cannot be kept is refused as NotRecorded before its events are attached",
  "gateway/connector/connector.ts": "a bridge write that fails is shown on the connector's status and tried again",
  "modules/issue/cron.ts": "a cron's run that is not kept is logged, and the next due cron goes on",
  "modules/game/game.ts": "a ledger entry that is not kept is logged, and the farm goes on",
  "modules/issue/assignment.ts": "an assignment write inside an issue transaction hands its database failure up to the caller's refusal",
  "modules/issue/store.ts": "an execution write inside an issue transaction hands its database failure up to the caller's refusal",
  "modules/issue/lifecycle.ts": "an issue that is not saved, split, edited, or linked to its session or orchestrator is told as a refusal",
  "modules/session/triggers.ts": "the source cursor and trigger commit together; a failed cron input is logged and retried without advancing its clock",
  "modules/session/work.ts":
    "a Session's first direct deliveries are registered atomically; a failed insert is returned so Session startup can stop and report NotRecorded",
  "modules/media/inputs.ts": "a rejected input commit removes its newly published file; failed cleanup retains its tombstone for restart recovery",
  "modules/memory/memory.ts": "a memory read or write that fails is logged and taken as none",
  "modules/session/inProcessRun.ts": "a run write fails as NotRecorded so an in-process run retries its end before accepting another input",
  "modules/session/registry.ts": "a session's own record that is not kept is logged without discarding its live execution",
  "modules/session/lifecycle.ts": "a report handed in that cannot be kept is told as a refusal, and the turn does not take it",
};

test("SqlError is caught only where a failed query is told or retried, each with its reason", () => {
  const src = join(import.meta.dirname, "..");
  const using = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("infra/db.ts") && !f.includes("testing/"))
    .filter((f) => /\binstanceof\s+SqlError\b/u.test(readFileSync(join(src, f), "utf8")))
    .map((f) => f.split("\\").join("/"))
    .toSorted();
  expect(using).toEqual(Object.keys(catching).toSorted());
});
