import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { messages, PGlite } from "@electric-sql/pglite";

// Writes db/generated from db/queries: each query's parameters and result columns are what Postgres says they are
// (a Parse and a Describe on PGlite, with the schema in place), so nothing is guessed from the text but what Postgres
// does not say: whether a computed column may be null, and the closed set of words a text column takes.

const db = resolve(import.meta.dirname, "../db");
const check = process.argv.includes("--check");

type Base = "int" | "real" | "text" | "bool" | "text[]" | "int[]";
interface Type {
  readonly base: Base;
  readonly nullable: boolean;
  /** A text column's closed set of words, by the name types.ts gives it. */
  readonly words?: string;
}

const problems: string[] = [];
const problem = (where: string, what: string, fix: string) => problems.push(`${where}: ${what}. Fix: ${fix}. See apps/server/scripts/pg-generate.ts`);

const schemaSql = readFileSync(join(db, "migrations", "0001_schema.up.sql"), "utf8");
const pg = new PGlite();
await pg.exec(schemaSql);

/** Postgres's types as the code reads them; bigint is none: a Postgres driver hands it back as a string. */
const baseOfType = (name: string): Base | undefined => {
  switch (name) {
    case "int2":
    case "int4":
      return "int";
    case "float4":
    case "float8":
    case "numeric":
      return "real";
    case "text":
    case "varchar":
    case "bpchar":
      return "text";
    case "bool":
      return "bool";
    case "_text":
      return "text[]";
    case "_int4":
      return "int[]";
    default:
      return undefined;
  }
};
const typeNames = new Map<number, string>();
for (const row of (await pg.query<{ oid: number; typname: string }>("select oid::int as oid, typname from pg_type")).rows) typeNames.set(row.oid, row.typname);

// The closed sets of words: a table's `check (col in ('a', …))`, read from its create statement.
const words = new Map<string, readonly string[]>();
const wordsOf = new Map<string, string>();
for (const m of schemaSql.matchAll(/create table (\w+) \(([\s\S]*?)\n\);/giu)) {
  const table = m[1] ?? "";
  for (const c of (m[2] ?? "").matchAll(/check \((\w+) in \(([^)]*)\)\)/giu)) {
    const set = [...(c[2] ?? "").matchAll(/'([^']*)'/gu)].map((w) => w[1] ?? "");
    if (set.length === 0) continue;
    const name = `Words_${table}_${c[1]}`;
    words.set(name, set);
    wordsOf.set(`${table}.${c[1]}`, name);
  }
}

// Every table's and view's columns, by the table's oid and the column's number as a Describe names them.
interface Column {
  readonly table: string;
  readonly name: string;
  readonly type: Type | undefined;
  readonly typname: string;
}
const byPlace = new Map<string, Column>();
const byName = new Map<string, Map<string, Column>>();
for (const row of (
  await pg.query<{ table_oid: number; table_name: string; attnum: number; attname: string; typname: string; notnull: boolean }>(
    `select c.oid::int as table_oid, c.relname as table_name, a.attnum::int as attnum, a.attname, t.typname, a.attnotnull as notnull
     from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped`,
  )
).rows) {
  const base = baseOfType(row.typname);
  const named = wordsOf.get(`${row.table_name}.${row.attname}`);
  const column: Column = {
    table: row.table_name,
    name: row.attname,
    typname: row.typname,
    type: base ? { base, nullable: !row.notnull, ...(named && base === "text" ? { words: named } : {}) } : undefined,
  };
  byPlace.set(`${row.table_oid}.${row.attnum}`, column);
  const of = byName.get(row.table_name) ?? new Map<string, Column>();
  of.set(row.attname, column);
  byName.set(row.table_name, of);
}

interface Query {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: "one" | "many" | "exec";
  readonly text: string;
}

function queriesOf(file: string): Query[] {
  const lines = readFileSync(join(db, "queries", file), "utf8").split("\n");
  const out: Query[] = [];
  let at: { name: string; kind: Query["kind"]; line: number; body: string[] } | undefined;
  const close = () => {
    if (!at) return;
    out.push({ file, line: at.line, name: at.name, kind: at.kind, text: at.body.join("\n").trim() });
  };
  for (const [i, line] of lines.entries()) {
    const head = /^-- name: (\w+) :(one|many|exec)\s*$/u.exec(line);
    if (head) {
      close();
      at = { name: head[1] ?? "", kind: head[2] === "one" ? "one" : head[2] === "many" ? "many" : "exec", line: i + 1, body: [line] };
    } else if (at) at.body.push(line);
  }
  close();
  return out;
}

interface Param {
  readonly name: string;
  readonly nullable: boolean;
}

interface Rewritten {
  readonly sql: string;
  readonly params: Param[];
  /** A result column's type as the query says it: `expr::int as name` (`::int?` when it may be null), or
   * `expr::table.column as name` for that column's type and words. */
  readonly hints: Map<string, { readonly nullable: boolean; readonly like?: Column }>;
}

/** sqlc.arg(name) and sqlc.narg(name) (null allowed) as $1…; the generator's own marks taken off the casts. */
function rewrite(q: Query): Rewritten {
  const params: Param[] = [];
  const hints: Rewritten["hints"] = new Map();
  // Comment lines are set aside while the code is read, so a parenthesis or a sqlc.arg in one is not taken for code.
  const comments: string[] = [];
  let code = q.text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? `/*comment ${comments.push(line) - 1}*/` : line))
    .join("\n");
  if (/\$\d/u.test(code)) problem(`${q.file}:${q.line} ${q.name}`, "a $N parameter has no name", "write sqlc.arg(<column>) instead");
  code = code.replace(/sqlc\.(n?arg)\((\w+)\)/giu, (_whole, kind: string, name: string) => {
    let i = params.findIndex((x) => x.name === name);
    if (i < 0) i = params.push({ name, nullable: kind.toLowerCase() === "narg" }) - 1;
    return `$${i + 1}`;
  });
  // ::table.column: the type of that column, words and all; Postgres is given the column's own type.
  code = code.replace(
    /::(\w+)\.(\w+)(\?)?(\s+as\s+"?(\w+)"?)?/giu,
    (whole, table: string, column: string, maybe: string | undefined, as: string | undefined, name: string | undefined) => {
      const like = byName.get(table)?.get(column);
      if (!like) {
        problem(`${q.file}:${q.line} ${q.name}`, `::${table}.${column} names no column`, "name a table's column, or cast to a type");
        return whole;
      }
      if (name) hints.set(name, { nullable: maybe === "?", like });
      return `::${like.typname}${as ?? ""}`;
    },
  );
  // ::type? as name: the column may be null.
  code = code.replace(/::([a-z0-9_]+(?:\[\])?)(\?)?(\s+as\s+"?(\w+)"?)/giu, (_whole, type: string, maybe: string | undefined, as: string, name: string) => {
    if (!hints.has(name)) hints.set(name, { nullable: maybe === "?" });
    return `::${type}${as}`;
  });
  if (/::[a-z0-9_]+\?/iu.test(code))
    problem(`${q.file}:${q.line} ${q.name}`, "a ::type? is not on a named result column", "write it as <expr>::type? as <name>");
  for (const m of code.matchAll(/\bcount\((?:\*|[\w.]+|distinct [\w.]+)\)(?:::int)?\s+as\s+(\w+)/giu))
    if (!hints.has(m[1] ?? "")) hints.set(m[1] ?? "", { nullable: false });
  const sql = code.replace(/\/\*comment (\d+)\*\//gu, (_whole, i: string) => comments[Number(i)] ?? "");
  return { sql, params, hints };
}

// What Postgres says of a statement, by the extended protocol: a Parse, a Describe of it, a Sync.
const encoder = new TextEncoder();
function message(code: string, body: Uint8Array) {
  const out = new Uint8Array(5 + body.length);
  out[0] = code.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}
const cstring = (s: string) => {
  const bytes = encoder.encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
};
const joined = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
interface Described {
  readonly params: readonly number[];
  readonly fields: readonly { readonly name: string; readonly tableID: number; readonly columnID: number; readonly dataTypeID: number }[];
}
function describe(sql: string): Promise<Described | string> {
  const parse = message("P", joined(cstring(""), cstring(sql), new Uint8Array(2)));
  const describeStatement = message("D", joined(encoder.encode("S"), cstring("")));
  const sync = message("S", new Uint8Array(0));
  return pg.execProtocol(joined(parse, describeStatement, sync), { throwOnError: true }).then(
    (answer): Described => {
      let params: number[] = [];
      let fields: Described["fields"] = [];
      for (const m of answer.messages) {
        if (m instanceof messages.ParameterDescriptionMessage) params = m.dataTypeIDs;
        if (m instanceof messages.RowDescriptionMessage) fields = m.fields;
      }
      return { params, fields };
    },
    // The failed statement leaves the protocol waiting for a Sync before the next one.
    (e: unknown) =>
      pg.execProtocol(sync).then(
        () => (e instanceof Error ? e.message : String(e)),
        () => (e instanceof Error ? e.message : String(e)),
      ),
  );
}

const keywords = new Set([
  "where",
  "join",
  "left",
  "inner",
  "on",
  "set",
  "order",
  "group",
  "limit",
  "values",
  "using",
  "natural",
  "cross",
  "returning",
  "select",
  "union",
  "and",
  "or",
  "as",
  "default",
]);

/** The aliases of the tables a query left joins: their columns may be null. */
function outerTables(sql: string) {
  const outer = new Set<string>();
  for (const m of sql.matchAll(/\bleft\s+(?:outer\s+)?join\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/giu)) {
    const alias = m[2] && !keywords.has(m[2].toLowerCase()) ? m[2] : m[1];
    if (m[1]) outer.add(m[1]);
    if (alias) outer.add(alias);
  }
  return outer;
}

const typeOf = (oid: number): Base | undefined => baseOfType(typeNames.get(oid) ?? "");

/** The tables a query names, by alias and by name. */
function tablesOf(sql: string) {
  const byAlias = new Map<string, string>();
  const notAlias = [...keywords].join("|");
  for (const m of sql.matchAll(new RegExp(`\\b(from|join|update|into)\\s+(\\w+)(?:\\s+(?:as\\s+)?(?!(?:${notAlias})\\b)(\\w+))?`, "giu"))) {
    const table = m[2] ?? "";
    if (!byName.has(table)) continue;
    byAlias.set(table, table);
    const alias = m[3];
    if (alias && !keywords.has(alias.toLowerCase())) byAlias.set(alias, table);
  }
  return byAlias;
}

function columnOf(sql: string, ref: string, tables: Map<string, string>): Column | undefined {
  const [first = "", second] = ref.replace(/"/gu, "").split(".");
  if (second) {
    const table = first === "excluded" ? /insert into (\w+)/iu.exec(sql)?.[1] : tables.get(first);
    return table ? byName.get(table)?.get(second) : undefined;
  }
  for (const table of new Set(tables.values())) {
    const c = byName.get(table)?.get(first);
    if (c) return c;
  }
  return undefined;
}

/** A parameter's type is what Postgres made of it; its words, and whether it may be null, those of the column it is
 * compared with, written to or set to (a column that may be null makes a value written to it nullable). */
function paramColumn(sql: string, i: number): { readonly words?: string; readonly nullable: boolean } {
  const tables = tablesOf(sql);
  const n = `\\$${i + 1}(?!\\d)`;
  const ref = '((?:\\w+\\.)?"?\\w+"?)';
  const op = "(?:=|<>|!=|<=|>=|<|>|\\bis not\\b|\\bis\\b|\\blike\\b)";
  let words: string | undefined;
  let nullable = false;
  const written = (c: Column | undefined) => {
    if (!c?.type) return;
    words ??= c.type.words;
    if (c.type.nullable) nullable = true;
  };
  const compared = (c: Column | undefined) => {
    words ??= c?.type?.words;
  };
  const insert = /insert into (\w+)\s*\(([^)]*)\)\s*values\s*\(/iu.exec(sql);
  if (insert) {
    const columns = (insert[2] ?? "").split(",").map((c) => c.trim().replace(/"/gu, ""));
    const values = splitTop(sql.slice(insert.index + insert[0].length));
    for (const [j, v] of values.entries())
      if (new RegExp(`^\\s*${n}(?:::[\\w\\[\\]]+)*\\s*$`, "u").test(v)) written(byName.get(insert[1] ?? "")?.get(columns[j] ?? ""));
  }
  for (const m of sql.matchAll(new RegExp(`\\bset\\b[^;]*?\\b${ref}\\s*=\\s*${n}`, "giu"))) written(columnOf(sql, m[1] ?? "", tables));
  for (const m of sql.matchAll(new RegExp(`,\\s*${ref}\\s*=\\s*${n}`, "giu"))) written(columnOf(sql, m[1] ?? "", tables));
  for (const m of sql.matchAll(new RegExp(`${ref}\\s*${op}\\s*${n}`, "giu"))) compared(columnOf(sql, m[1] ?? "", tables));
  for (const m of sql.matchAll(new RegExp(`${n}(?:::[\\w\\[\\]]+)*\\s*${op}\\s*${ref}`, "giu"))) compared(columnOf(sql, m[1] ?? "", tables));
  return { ...(words ? { words } : {}), nullable };
}

/** The comma-separated values of a values (…) list, up to its closing parenthesis. */
function splitTop(rest: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of rest) {
    if (ch === "(") depth += 1;
    if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const schemaOf = (t: Type) => {
  const base =
    t.words ??
    (t.base === "int"
      ? "Schema.Int"
      : t.base === "real"
        ? "Schema.Number"
        : t.base === "bool"
          ? "Schema.Boolean"
          : t.base === "text[]"
            ? "Schema.Array(Schema.String)"
            : t.base === "int[]"
              ? "Schema.Array(Schema.Int)"
              : "Schema.String");
  return t.nullable ? `Schema.NullOr(${base})` : base;
};

const reserved = new Set(["in", "then", "delete", "new", "default", "function", "class", "return", "import", "export", "for", "if", "do", "case"]);
const fnName = (name: string) => {
  const lower = (name[0] ?? "").toLowerCase() + name.slice(1);
  return reserved.has(lower) ? `${lower}_` : lower;
};

// One PGlite connection: each query's Parse and Describe go one after another, before any file is written.
const files = readdirSync(join(db, "queries"))
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const queries = new Map<string, { readonly q: Query; readonly r: Rewritten }[]>();
for (const file of files) {
  const list: { readonly q: Query; readonly r: Rewritten }[] = [];
  for (const q of queriesOf(file)) list.push({ q, r: rewrite(q) });
  queries.set(file, list);
}
const describedOf = new Map<string, Described | string>();
let chain = Promise.resolve();
for (const list of queries.values())
  for (const { r } of list)
    chain = chain.then(() =>
      describe(r.sql).then((d) => {
        describedOf.set(r.sql, d);
      }),
    );
await chain;

const made = new Map<string, string>();
const usedWords = new Set<string>();
for (const file of files) {
  const parts: string[] = [];
  const imports = new Set<string>();
  for (const { q, r } of queries.get(file) ?? []) {
    const where = `${q.file}:${q.line} ${q.name}`;
    const described = describedOf.get(r.sql) ?? "not described";
    if (typeof described === "string") {
      problem(
        where,
        `Postgres does not take it: ${described}`,
        "write it in Postgres's dialect; a parameter Postgres cannot type wants a cast (sqlc.arg(x)::int)",
      );
      continue;
    }
    const params = r.params.map((p, i) => {
      const base = typeOf(described.params[i] ?? 0);
      if (!base)
        problem(
          where,
          `sqlc.arg(${p.name}) is ${typeNames.get(described.params[i] ?? 0) ?? "of no type"}`,
          "cast it to int, float8, text, boolean, text[] or int[]",
        );
      const at = paramColumn(r.sql, i);
      const w = base === "text" ? at.words : undefined;
      return { name: p.name, type: { base: base ?? "text", nullable: p.nullable || at.nullable, ...(w ? { words: w } : {}) } satisfies Type };
    });
    const outer = outerTables(r.sql);
    const result =
      q.kind === "exec"
        ? []
        : described.fields.map((f) => {
            const hint = r.hints.get(f.name);
            const column = f.tableID === 0 ? undefined : byPlace.get(`${f.tableID}.${f.columnID}`);
            const base = typeOf(f.dataTypeID);
            if (!base) {
              problem(
                where,
                `the result column ${f.name} is ${typeNames.get(f.dataTypeID) ?? "of no type"}`,
                `cast it: <expr>::int as ${f.name} (or ::float8, ::text, ::boolean)`,
              );
              return { name: f.name, type: { base: "text", nullable: true } satisfies Type };
            }
            if (hint?.like?.type) return { name: f.name, type: { ...hint.like.type, base, nullable: hint.nullable } };
            if (hint) return { name: f.name, type: { base, nullable: hint.nullable } };
            if (column?.type) {
              // Postgres names the table, not the alias: only a table every alias of which is left joined may be null here.
              const aliases = [...tablesOf(r.sql).entries()].filter(([alias, table]) => table === column.table && alias !== table).map(([alias]) => alias);
              const left = (aliases.length > 0 ? aliases : [column.table]).every((a) => outer.has(a));
              return { name: f.name, type: { ...column.type, base, nullable: column.type.nullable || left } };
            }
            problem(
              where,
              `the result column ${f.name} is computed, so whether it may be null is not known`,
              `write it as <expr>::${typeNames.get(f.dataTypeID)} as ${f.name} (::type? when it may be null)`,
            );
            return { name: f.name, type: { base, nullable: true } satisfies Type };
          });
    for (const t of [...params.map((p) => p.type), ...result.map((c) => c.type)]) if (t.words) imports.add(t.words);
    const field = (name: string, t: Type) => `  ["${name}"]: ${schemaOf(t)},`;
    parts.push(
      `export const ${q.name}Params = Schema.Struct({\n${params.map((p) => field(p.name, p.type)).join("\n")}\n})\nexport type ${q.name}Params = typeof ${q.name}Params.Type\n\n`,
    );
    if (q.kind !== "exec")
      parts.push(
        `export const ${q.name}Result = Schema.Struct({\n${result.map((c) => field(c.name, c.type)).join("\n")}\n})\nexport type ${q.name}Result = typeof ${q.name}Result.Type\n\n`,
      );
    parts.push(`export const ${q.name}Sql = ${JSON.stringify(r.sql)}\n`);
    const call = q.kind === "exec" ? "void" : q.kind === "one" ? "findOne" : "findAll";
    const args = `[${params.map((p) => `p["${p.name}"]`).join(", ")}]`;
    const none = params.length === 0;
    parts.push(
      `export const ${fnName(q.name)} = Effect.fn("${q.name}")(function* (${none ? "" : `params: ${q.name}Params`}) {\n` +
        `  const sql = yield* SqlClient.SqlClient\n` +
        `  return yield* SqlSchema.${call}({\n` +
        `    Request: ${q.name}Params,\n` +
        (q.kind === "exec" ? "" : `    Result: ${q.name}Result,\n`) +
        `    execute: (${none ? "" : "p"}) => sql.unsafe(${q.name}Sql, ${none ? "[]" : args}),\n` +
        `  })(${none ? "{}" : "params"})\n})\n`,
    );
  }
  for (const w of imports) usedWords.add(w);
  const typesLine = imports.size > 0 ? `\nimport { ${[...imports].toSorted().join(", ")} } from "./types.js"\n` : "";
  made.set(
    file.replace(/\.sql$/u, ".sql.ts"),
    `// Generated by scripts/pg-generate.ts. DO NOT EDIT.\n// Source: ${file}\n\nimport { Effect, Schema } from "effect"\nimport { SqlClient, SqlSchema } from "effect/sql"\n${typesLine}\n${parts.join("\n")}`,
  );
}

made.set(
  "types.ts",
  `// Generated by scripts/pg-generate.ts. DO NOT EDIT.\nimport { Schema } from "effect"\n\n` +
    [...words.entries()]
      .filter(([name]) => usedWords.has(name))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, set]) => `export const ${name} = Schema.Literals(${JSON.stringify(set)})\nexport type ${name} = typeof ${name}.Type\n`)
      .join("\n"),
);

await pg.close();

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const out = join(db, "generated");
const have = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith(".ts")) : [];
if (check) {
  const stale = [...new Set([...have, ...made.keys()])].filter((n) => made.get(n) !== (have.includes(n) ? readFileSync(join(out, n), "utf8") : undefined));
  if (stale.length > 0) {
    console.error(`db/generated is stale (${stale.join(", ")}). Fix: vp run --filter @vibevalley/server db:generate`);
    process.exit(1);
  }
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  for (const [name, body] of made) writeFileSync(join(out, name), body);
}
