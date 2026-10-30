import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const db = join(import.meta.dirname, "../../db");
const src = join(import.meta.dirname, "..");
const schema = readFileSync(join(db, "migrations", "0001_schema.up.sql"), "utf8");
const tables = [...schema.matchAll(/create table (?:if not exists )?(\w+)/giu)].map((m) => m[1]!.toLowerCase());
const indexes = [...schema.matchAll(/create (?:unique )?index (?:if not exists )?(\w+) on (\w+)/giu)].map((m) => ({
  name: m[1]!.toLowerCase(),
  table: m[2]!.toLowerCase(),
}));
const enums = new Set([...schema.matchAll(/create type (\w+) as enum/giu)].map((m) => m[1]!.toLowerCase()));
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
        expect({ table: t, plural: word.endsWith("s") && !singularInS.has(word) ? word : undefined }).toEqual({ table: t, plural: undefined });
    }
  });

  it("keeps a closed set of words in an enum type named after its table and column", () => {
    expect([...schema.matchAll(/^\s+\w+\s+text\b.*check \(\w+ in \(/gimu)].map((m) => m[0].trim())).toEqual([]);
    let table = "";
    const named: string[] = [];
    for (const line of schema.split("\n")) {
      table = /^create table (\w+)/iu.exec(line)?.[1]?.toLowerCase() ?? table;
      const column = /^\s+(\w+)\s+(\w+)/u.exec(line);
      if (column && enums.has(column[2]!.toLowerCase()) && column[2]!.toLowerCase() !== `${table}_${column[1]!.toLowerCase()}`)
        named.push(`${table}.${column[1]}`);
    }
    expect(named).toEqual([]);
  });

  it("names every index after its table", () => {
    for (const i of indexes)
      expect({ index: i.name, table: i.table, starts: i.name.startsWith(`${i.table}_`) }).toEqual({ index: i.name, table: i.table, starts: true });
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
