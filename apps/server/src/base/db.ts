// The database: PGlite (Postgres compiled to WASM) in the home's db folder, inside this process. One connection, so a
// row's order is its commit order (the chat's numbers rely on it). db/migrations/0001_schema.up.sql is the one baseline,
// edited in place: an old database is not upgraded, it is made again (AGENTS.md: no compatibility). The queries in
// db/queries are compiled by effect-sqlc into db/generated (scripts/db-generate.ts).

import { PGlite } from "@electric-sql/pglite";
import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite";
import { type Cause, Clock, Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDir, ServerConfig } from "./config.ts";

const baseline = resolve(import.meta.dirname, "../../db/migrations/0001_schema.up.sql");
const baselineSql = () => readFileSync(baseline, "utf8");
export const baselineHash = () => createHash("sha256").update(baselineSql()).digest("hex").slice(0, 16);

/** A folder's database made from another baseline is moved aside, whole, to <folder>.<hash>-<time>: it is not
 * upgraded (AGENTS.md: no compatibility) and never deleted. The baseline it was made from is in <folder>.schema; a
 * folder without one is taken to be today's. Returns where the old one went, if it moved. */
export function setAsideStale(where: string, hash: string, now: number): string | undefined {
  const mark = where + ".schema";
  if (!existsSync(where) || !existsSync(mark)) return undefined;
  const was = readFileSync(mark, "utf8").trim();
  if (was === hash) return undefined;
  const aside = `${where}.${was || "unknown"}-${now}`;
  renameSync(where, aside);
  renameSync(mark, aside + ".schema");
  return aside;
}

/** Every new database after the first in memory starts from a copy of that one's files right after the baseline ran:
 * running the baseline is most of a test's setup (in memory about 570 ms against 110; a new folder on disk, as the tests'
 * restarts make, about 830 ms against 320). A server makes one database and no copy, so it runs the baseline. */
let memoryBase: Promise<Blob> | undefined;

/** In memory, a database given back is emptied and kept for the next farm: making a PGlite from the copy above takes
 * about 110 ms, emptying one about 1 ms. Each farm open at the same time has its own. Only one whose schema nobody
 * changed is kept (tests add triggers, drop or rename tables to make writes fail): an event trigger marks the session on
 * any DDL, and a marked one is closed. The migrations' own table is not emptied: a kept database has the baseline. */
const spare: PGlite[] = [];
let emptyAll: string | undefined;
const ddlMark = "vibevalley.ddl";
const watchDdl = `CREATE FUNCTION vibevalley_ddl_mark() RETURNS event_trigger LANGUAGE plpgsql AS $$
  BEGIN PERFORM set_config('${ddlMark}', '1', false); END $$;
CREATE EVENT TRIGGER vibevalley_ddl ON ddl_command_end EXECUTE FUNCTION vibevalley_ddl_mark();`;
const unmark = `SELECT set_config('${ddlMark}', '', false)`;
const changed = async (pglite: PGlite) =>
  (await pglite.query<{ mark: string | null }>(`SELECT current_setting('${ddlMark}', true) AS mark`)).rows[0]?.mark === "1";
/** Empties a database given back and keeps it, or closes it when its schema was changed. Deleting with the foreign keys
 * off is cheaper than TRUNCATE, which makes every table's files again; restarting the sequences is DDL itself, so the
 * mark is cleared after. */
const giveBack = async (pglite: PGlite) => {
  if (await changed(pglite)) return pglite.close();
  if (emptyAll === undefined) {
    const tables = await pglite.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'effect_sql_migrations'",
    );
    const sequences = await pglite.query<{ name: string }>("SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public'");
    emptyAll = [
      "SET session_replication_role = replica;",
      ...tables.rows.map((t) => `DELETE FROM "${t.name}";`),
      "SET session_replication_role = origin;",
      ...sequences.rows.map((q) => `ALTER SEQUENCE "${q.name}" RESTART;`),
      `${unmark};`,
    ].join(" ");
  }
  await pglite.exec(emptyAll);
  spare.push(pglite);
};

const migrate = (pglite: PGlite, client: SqlClient.SqlClient) =>
  PgliteMigrator.run({
    loader: PgliteMigrator.fromRecord({ "1_schema": Effect.promise(() => pglite.exec(baselineSql())).pipe(Effect.asVoid) }),
  }).pipe(Effect.provideService(SqlClient.SqlClient, client), Effect.orDie);

/** The database as an SqlClient, with the schema in place. */
export const Database = PgliteClient.layerFrom(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const where = dbDir(config);
    const memory = where === "memory";
    const hash = baselineHash();
    if (!memory) {
      const aside = setAsideStale(where, hash, yield* Clock.currentTimeMillis);
      if (aside) yield* Effect.logWarning(`vibevalley: the database was made from another schema; it is set aside at ${aside} and a new one is made`);
    }
    // A folder that is not there yet is a new database: it can start from the copy too.
    const base = memory || !existsSync(where) ? memoryBase : undefined;
    const kept = memory ? spare.pop() : undefined;
    const from = async () => (base ? { loadDataDir: await base } : undefined);
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => kept ?? (memory ? PGlite.create(await from()) : PGlite.create(where, await from()))),
      (db) => Effect.promise(() => (memory ? giveBack(db) : db.close())),
    );
    const client = yield* PgliteClient.fromClient({ liveClient: pglite });
    if (!kept) yield* migrate(pglite, client);
    // The first in memory watches for DDL before the copy is taken, so every copy does too.
    if (memory && !kept && !base) yield* Effect.promise(() => pglite.exec(watchDdl));
    if (memory && !kept) yield* Effect.promise(() => pglite.exec(unmark));
    // Taken before anyone writes: the copy is the baseline alone.
    if (memory && !base) memoryBase ??= Promise.resolve(yield* Effect.promise(() => pglite.dumpDataDir("none")));
    if (!memory) writeFileSync(where + ".schema", hash + "\n");
    return client;
  }),
).pipe(Layer.orDie);

/** What the database said, from under the SqlError around it. */
export function causeMessage(e: unknown): string {
  let at: unknown = e;
  let said = e instanceof Error ? e.message : String(e);
  while (at instanceof Error && at.cause !== undefined) {
    at = at.cause;
    if (at instanceof Error && at.message) said = at.message;
  }
  return said;
}

/**
 * The farm's database as the services use it: a generated query (db/generated) run against it. The database is in this
 * process, so a query that fails is a bug or a full disk: run makes it a defect; attempt keeps the failure for the few
 * callers that log it and go on, or tell it as a refusal.
 */
export interface Db {
  readonly run: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
  readonly attempt: <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A, E>;
  /** The one row, or undefined when there is none. Only no row is none: a query that fails is still a defect. */
  readonly one: <A, E>(query: Effect.Effect<A, E | Cause.NoSuchElementError, SqlClient.SqlClient>) => Effect.Effect<A | undefined>;
  /** work in one transaction; the database's own failure is a defect, work's other failures stay. */
  readonly inTx: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
}

export const Db = Context.Service<Db>("vibevalley/Db");

export const DbLayer = Layer.effect(
  Db,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempt = <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provideService(query, SqlClient.SqlClient, sql);
    const run = <A, E>(query: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.orDie(attempt(query));
    return Db.of({
      run,
      attempt,
      one: (query) => Effect.map(run(Effect.catchNoSuchElement(query)), Option.getOrUndefined),
      inTx: <A, E>(work: Effect.Effect<A, E>) =>
        sql.withTransaction(work).pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>,
    });
  }),
);
