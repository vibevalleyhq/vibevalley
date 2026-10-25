// The schema's own rules: one baseline (db/migrations/0001_schema.up.sql) that is changed in place, never a second
// migration; every table named <module> or <module>_<concept>, singular, the module the src folder that owns it; every
// index named after its table; and each table's SQL in db/queries/<table>.sql, one file a table.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const db = join(import.meta.dirname, "../../db");
const src = join(import.meta.dirname, "..");
const schema = readFileSync(join(db, "migrations", "0001_schema.up.sql"), "utf8");
const tables = [...schema.matchAll(/create table (?:if not exists )?(\w+)/gi)].map((m) => m[1]!.toLowerCase());
const indexes = [...schema.matchAll(/create (?:unique )?index (?:if not exists )?(\w+) on (\w+)/gi)].map((m) => ({
  name: m[1]!.toLowerCase(),
  table: m[2]!.toLowerCase(),
}));
const modules = readdirSync(src).filter((d) => statSync(join(src, d)).isDirectory());

/** A plural ends in s; these words end in s and are singular. */
const singularInS = new Set(["status", "alias"]);

describe("the schema", () => {
  it("is one baseline, changed in place", () => {
    expect(readdirSync(join(db, "migrations"))).toEqual(["0001_schema.up.sql"]);
  });

  it("names every table <module> or <module>_<concept>, singular", () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const module = modules.find((m) => t === m || t.startsWith(`${m}_`));
      expect({ table: t, module }).toEqual({ table: t, module: expect.any(String) });
      for (const word of t.split("_"))
        expect({
          table: t,
          plural: word.endsWith("s") && !singularInS.has(word) ? word : undefined,
        }).toEqual({ table: t, plural: undefined });
    }
  });

  it("names every index after its table", () => {
    for (const i of indexes)
      expect({ index: i.name, table: i.table, starts: i.name.startsWith(`${i.table}_`) }).toEqual({
        index: i.name,
        table: i.table,
        starts: true,
      });
  });

  it("keeps each table's SQL in a file of its own, and only there", () => {
    const queries = readdirSync(join(db, "queries")).map((f) => f.replace(/\.sql$/, ""));
    for (const q of queries) expect({ file: q, table: tables.includes(q) }).toEqual({ file: q, table: true });
    for (const q of queries) {
      const text = readFileSync(join(db, "queries", `${q}.sql`), "utf8").replace(/--.*$/gm, "");
      // A file writes only its own table (a join may read another).
      const touched = [...text.matchAll(/\b(?:insert into|(?<!do )update|delete from)\s+(\w+)/gi)].map((m) => m[1]!.toLowerCase());
      for (const t of touched) expect({ file: q, writes: t }).toEqual({ file: q, writes: q });
    }
  });
});
