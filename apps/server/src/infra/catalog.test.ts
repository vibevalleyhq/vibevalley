import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabase } from "#/testing/layers.ts";

const generated = join(import.meta.dirname, "../../db/generated");

describe("the schema in the database", () => {
  it.effect("compiles every generated query, without running it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const queries: [string, string][] = [];
      for (const file of readdirSync(generated).filter((f) => f.endsWith(".sql.ts"))) {
        const module = (yield* Effect.promise(() => import(join(generated, file)))) as Record<string, unknown>;
        for (const [name, text] of Object.entries(module)) if (name.endsWith("Sql") && typeof text === "string") queries.push([`${file} ${name}`, text]);
      }
      expect(queries.length).toBeGreaterThan(100);
      const failed: string[] = [];
      for (const [name, text] of queries) {
        // EXPLAIN prepares the statement against the tables and columns without running it.
        const prepared = yield* Effect.exit(sql.unsafe(`EXPLAIN ${text}`));
        if (prepared._tag === "Failure") failed.push(name);
      }
      expect(
        failed,
        "a generated query does not fit the schema. Fix: vp run --filter @vibevalley/server db:generate after changing db/queries or the migration",
      ).toEqual([]);
    }).pipe(Effect.provide(testDatabase())),
  );

  it.effect("has an index that starts with every foreign key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const bare = yield* Effect.orDie(
        sql<{ table: string; column: string }>`
          SELECT m.name AS "table", f."from" AS "column"
          FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND f.seq = 0
            AND NOT EXISTS (SELECT 1 FROM pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
                            WHERE ii.seqno = 0 AND ii.name = f."from")
          ORDER BY 1, 2`,
      );
      expect(
        bare.map((r) => `${r.table}.${r.column}`),
        "a foreign key with no index that starts with it. Fix: CREATE INDEX <table>_by_<column> in 0001_schema.up.sql",
      ).toEqual([]);
    }).pipe(Effect.provide(testDatabase())),
  );
});
