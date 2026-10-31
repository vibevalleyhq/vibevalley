// The schema as the database itself reads it: every generated query compiles against it, and every foreign key has an
// index that starts with it. schema.test.ts reads the SQL's text for the rules about names; this asks pg_catalog.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabase } from "@/testing/layers.ts";

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
        // PREPARE plans the statement against the schema (tables, columns, types) and runs nothing.
        const prepared = yield* Effect.exit(sql.unsafe(`PREPARE checked AS ${text.replace(/;\s*$/u, "")}`));
        if (prepared._tag === "Failure") failed.push(name);
        else yield* Effect.orDie(sql.unsafe("DEALLOCATE checked"));
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
          SELECT c.conrelid::regclass::text AS table, a.attname AS column
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
          ORDER BY 1, 2`,
      );
      expect(
        bare.map((r) => `${r.table}.${r.column}`),
        "a foreign key with no index that starts with it. Fix: CREATE INDEX <table>_by_<column> in 0001_schema.up.sql",
      ).toEqual([]);
    }).pipe(Effect.provide(testDatabase())),
  );
});
