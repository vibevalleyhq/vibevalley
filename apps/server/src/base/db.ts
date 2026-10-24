// The database: PGlite (Postgres compiled to WASM) in the home's db folder, inside this process. One connection, so a
// row's order is its commit order (the chat's numbers rely on it). db/migrations/0001_schema.up.sql is the one baseline,
// edited in place: an old database is not upgraded, it is made again (AGENTS.md: no compatibility). The queries in
// db/queries are compiled by effect-sqlc into db/generated (scripts/db-generate.ts).

import { PGlite } from "@electric-sql/pglite";
import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite";
import { Cause, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDir, Settings } from "./config.ts";

export const optional = <A, E, R>(effect: Effect.Effect<A, E | Cause.NoSuchElementError, R>): Effect.Effect<Option.Option<A>, E, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoSuchElementError", () => Effect.succeed(Option.none())),
  );

const baseline = resolve(import.meta.dirname, "../../db/migrations/0001_schema.up.sql");
const baselineSql = () => readFileSync(baseline, "utf8");
export const baselineHash = () => createHash("sha256").update(baselineSql()).digest("hex").slice(0, 16);

/** A folder's database made from another baseline is moved aside, whole, to <folder>.<hash>-<time>: it is not
 * upgraded (AGENTS.md: no compatibility) and never deleted. The baseline it was made from is in <folder>.schema; a
 * folder without one is taken to be today's. Returns where the old one went, if it moved. */
export function setAsideStale(where: string, hash: string, now = Date.now()): string | undefined {
  const mark = where + ".schema";
  if (!existsSync(where) || !existsSync(mark)) return undefined;
  const was = readFileSync(mark, "utf8").trim();
  if (was === hash) return undefined;
  const aside = `${where}.${was || "unknown"}-${now}`;
  renameSync(where, aside);
  renameSync(mark, aside + ".schema");
  return aside;
}

/** In memory (the tests), every database after the first starts from a copy of the first one's files right after the
 * baseline ran: making one from scratch is most of a test's setup. */
let memoryBase: Promise<Blob> | undefined;

const migrate = (pglite: PGlite, client: SqlClient.SqlClient) =>
  PgliteMigrator.run({
    loader: PgliteMigrator.fromRecord({ "1_schema": Effect.promise(() => pglite.exec(baselineSql())).pipe(Effect.asVoid) }),
  }).pipe(Effect.provideService(SqlClient.SqlClient, client), Effect.orDie);

/** The database as an SqlClient, with the schema in place. */
export const Database = PgliteClient.layerFrom(
  Effect.gen(function* () {
    const config = yield* Settings;
    const where = dbDir(config);
    const memory = where === "memory";
    const hash = baselineHash();
    if (!memory) {
      const aside = setAsideStale(where, hash);
      if (aside) yield* Effect.logWarning(`vibevalley: the database was made from another schema; it is set aside at ${aside} and a new one is made`);
    }
    const base = memory ? memoryBase : undefined;
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => (memory ? PGlite.create(base ? { loadDataDir: await base } : undefined) : PGlite.create(where))),
      (db) => Effect.promise(() => db.close()),
    );
    const client = yield* PgliteClient.fromClient({ liveClient: pglite });
    yield* migrate(pglite, client);
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
