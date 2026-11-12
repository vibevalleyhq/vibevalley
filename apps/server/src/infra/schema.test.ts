import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const db = join(import.meta.dirname, "../../db");
const src = join(import.meta.dirname, "..");
const schema = readFileSync(join(db, "migrations", "0001_schema.up.sql"), "utf8");
const tables = [...schema.matchAll(/create (?:virtual )?table (?:if not exists )?(\w+)/giu)].map((m) => m[1]!.toLowerCase());
const indexes = [...schema.matchAll(/create (?:unique )?index (?:if not exists )?(\w+) on (\w+)/giu)].map((m) => ({
  name: m[1]!.toLowerCase(),
  table: m[2]!.toLowerCase(),
}));
const modules = ["platform", "modules", "gateway"].flatMap((g) => readdirSync(join(src, g)).filter((d) => statSync(join(src, g, d)).isDirectory()));

/** A plural ends in s; these words end in s and are singular. */
const singularInS = new Set(["status", "alias", "ingress"]);

describe("the schema", () => {
  it("is one baseline, changed in place", () => {
    expect(
      readdirSync(join(db, "migrations")),
      "the schema is one baseline, changed in place: an old database is moved aside at start, not migrated. Fix: put the change into 0001_schema.up.sql and delete the new file, then `vp run --filter @vibevalley/server db:generate`. See docs/subsystems/foundation.md",
    ).toEqual(["0001_schema.up.sql"]);
  });

  it("names every table <module> or <module>_<concept>, singular", () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const module = modules.find((m) => t === m || t.startsWith(`${m}_`));
      expect(
        { table: t, module },
        "a table is named for the module that owns it, <module> or <module>_<concept>. Fix: rename it after its folder under apps/server/src, with its queries file in db/queries. See docs/subsystems/foundation.md",
      ).toEqual({ table: t, module: expect.any(String) });
      for (const word of t.split("_"))
        expect(
          { table: t, plural: word.endsWith("s") && !singularInS.has(word) ? word : undefined },
          "a table's name is singular: a row is one of it. Fix: drop the s (add the word to singularInS if it is singular already). See apps/server/src/infra/schema.test.ts",
        ).toEqual({ table: t, plural: undefined });
    }
  });

  it("writes a closed set of words as its own column's check", () => {
    expect(
      [...schema.matchAll(/create type/giu)].length,
      "SQLite has no enum types. Fix: make the column text with check (<column> in (…)) on its own line; the generated code reads the words from it. See apps/server/scripts/sqlite-generate.ts",
    ).toBe(0);
    const elsewhere = schema
      .split("\n")
      .map((line) => ({ column: /^\s+(\w+)\s+text\b/u.exec(line)?.[1], checked: /check \((\w+) in \(/iu.exec(line)?.[1] }))
      .filter((c) => c.column !== undefined && c.checked !== undefined && c.checked !== c.column);
    expect(
      elsewhere,
      "a column's words are checked on another column's line, so the generated code gives them to the wrong one. Fix: move the check to its column. See apps/server/scripts/sqlite-generate.ts",
    ).toEqual([]);
  });

  it("names every index after its table", () => {
    for (const i of indexes)
      expect(
        { index: i.name, table: i.table, starts: i.name.startsWith(`${i.table}_`) },
        "an index's name starts with its table's. Fix: rename it <table>_<columns>. See docs/subsystems/foundation.md",
      ).toEqual({ index: i.name, table: i.table, starts: true });
  });

  it("indexes every foreign key", () => {
    const sql = schema.replace(/--.*$/gmu, "");
    // The columns an index can start from: a table's primary key, a unique column or list, an index's first column.
    const leading = new Set<string>();
    const keys: string[] = [];
    for (const [, table, body] of sql.matchAll(/create table (\w+) \((.*?)\n\);/gisu))
      for (const line of body!.split("\n").map((l) => l.trim())) {
        const list = /^(?:primary key|unique)\s*\((\w+)/iu.exec(line);
        if (list) leading.add(`${table}.${list[1]}`.toLowerCase());
        const column = /^(\w+)\s+\w+/u.exec(line)?.[1]?.toLowerCase();
        if (list || column === undefined || ["check", "primary", "unique"].includes(column)) continue;
        if (/\b(?:primary key|unique)\b/iu.test(line)) leading.add(`${table}.${column}`.toLowerCase());
        if (/\breferences\b/iu.test(line)) keys.push(`${table}.${column}`.toLowerCase());
      }
    for (const [, table, column] of sql.matchAll(/create (?:unique )?index \w+ on (\w+)(?: using \w+)? ?\((\w+)/giu))
      leading.add(`${table}.${column}`.toLowerCase());
    for (const [, table, column] of sql.matchAll(/alter table (\w+) add foreign key \((\w+)\)/giu)) keys.push(`${table}.${column}`.toLowerCase());
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.filter((k) => !leading.has(k)),
      "a foreign key column has no index that starts with it: Postgres does not make one, so a cascading delete and a lookup by it scan the table. Fix: `CREATE INDEX <table>_by_<column> on <table> (<column>)` in 0001_schema.up.sql (add `where <column> is not null` for a nullable one). See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  it("bounds every query that reads many rows", () => {
    const unbounded: string[] = [];
    for (const file of readdirSync(join(db, "queries")))
      for (const block of readFileSync(join(db, "queries", file), "utf8").split(/\n\s*\n/u)) {
        const name = /-- name: (\w+) :many/u.exec(block)?.[1];
        if (name && !/\blimit\b/iu.test(block.replace(/--.*$/gmu, "")) && !/^-- bound: \S/mu.test(block)) unbounded.push(`${file}: ${name}`);
      }
    expect(
      unbounded,
      "a :many query reads every row it matches, and a table that only grows makes it slower each day. Fix: add `limit`, or say under its name what keeps it small in a `-- bound: <why>` line (one parent's rows, only open ones, pruned after n days). See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  it("keeps each table's SQL in a file of its own, and only there", () => {
    const queries = readdirSync(join(db, "queries")).map((f) => f.replace(/\.sql$/u, ""));
    for (const q of queries) expect({ file: q, table: tables.includes(q) }).toEqual({ file: q, table: true });
    for (const q of queries) {
      const text = readFileSync(join(db, "queries", `${q}.sql`), "utf8").replace(/--.*$/gmu, "");
      // A file writes only its own table (a join may read another).
      const touched = [...text.matchAll(/\b(?:insert into|(?<!do )update|delete from)\s+(\w+)/giu)].map((m) => m[1]!.toLowerCase());
      for (const t of touched) expect({ file: q, writes: t }).toEqual({ file: q, writes: q });
    }
  });
});
