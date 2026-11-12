import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { testDb } from "#/testing/layers.ts";

const generated = join(import.meta.dirname, "../../db/generated");

describe("the schema in the database", () => {
  test("compiles every generated query, without running it", async () => {
    await using db = await testDb();
    const queries: [string, string][] = [];
    for (const file of readdirSync(generated).filter((f) => f.endsWith(".sql.ts"))) {
      const module: Record<string, unknown> = await import(join(generated, file));
      for (const [name, text] of Object.entries(module)) if (name.endsWith("Sql") && typeof text === "string") queries.push([`${file} ${name}`, text]);
    }
    expect(queries.length).toBeGreaterThan(100);
    const failed: string[] = [];
    for (const [i, [name, text]] of queries.entries()) {
      // PREPARE resolves the statement against the tables and columns, its parameters typed, without running it.
      const prepared = await db.sql.exec(`PREPARE checked_${i} AS ${text}`).then(
        () => true,
        () => false,
      );
      if (!prepared) failed.push(name);
      else await db.sql.exec(`DEALLOCATE checked_${i}`);
    }
    expect(
      failed,
      "a generated query does not fit the schema. Fix: vp run --filter @vibevalley/server db:generate after changing db/queries or the migration",
    ).toEqual([]);
  });

  test("has an index that starts with every foreign key", async () => {
    await using db = await testDb();
    const bare = await db.sql.query(`
          SELECT c.conrelid::regclass::text AS "table", a.attname::text AS "column"
          FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
          ORDER BY 1, 2`);
    expect(
      bare.map((r) => `${String(r["table"])}.${String(r["column"])}`),
      "a foreign key with no index that starts with it. Fix: CREATE INDEX <table>_by_<column> in 0001_schema.up.sql",
    ).toEqual([]);
  });
});
