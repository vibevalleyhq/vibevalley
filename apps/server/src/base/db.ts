// The database: PGlite (Postgres compiled to WASM) in the home's db folder, inside this process. One connection, so a
// row's order is its commit order (the chat's numbers rely on it). db/migrations/0001_schema.up.sql is the one baseline,
// edited in place: an old database is not upgraded, it is made again (AGENTS.md: no compatibility). The queries in
// db/queries are compiled by effect-sqlc into db/generated (scripts/db-generate.ts).

import { PGlite } from "@electric-sql/pglite";
import { PgliteClient, PgliteMigrator } from "@effect/sql-pglite";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDir, Settings } from "./config.ts";

const baseline = resolve(import.meta.dirname, "../../db/migrations/0001_schema.up.sql");

/** The database as an SqlClient, with the schema in place. */
export const Database = PgliteClient.layerFrom(
  Effect.gen(function* () {
    const config = yield* Settings;
    const where = dbDir(config);
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create(where === "memory" ? undefined : where)),
      (db) => Effect.promise(() => db.close()),
    );
    const client = yield* PgliteClient.fromClient({ liveClient: pglite });
    yield* PgliteMigrator.run({
      loader: PgliteMigrator.fromRecord({ "1_schema": Effect.promise(() => pglite.exec(readFileSync(baseline, "utf8"))).pipe(Effect.asVoid) }),
    }).pipe(Effect.provideService(SqlClient.SqlClient, client), Effect.orDie);
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
