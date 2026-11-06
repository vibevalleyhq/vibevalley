import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = resolve(import.meta.dirname, "../db");
const check = process.argv.includes("--check");

type Base = "int" | "real" | "text" | "bool" | "json" | "text[]" | "int[]";
interface Type {
  readonly base: Base;
  readonly nullable: boolean;
  /** A text column's closed set of words, by the name types.ts gives it. */
  readonly words?: string;
}
interface Column {
  readonly type: Type;
}

const problems: string[] = [];
const problem = (where: string, what: string, fix: string) => problems.push(`${where}: ${what}. Fix: ${fix}. See apps/server/scripts/sqlite-generate.ts`);

// The catalog: every table's and view's columns, from the schema as SQLite read it.
const schemaSql = readFileSync(join(db, "migrations", "0001_schema.up.sql"), "utf8");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(schemaSql);
const words = new Map<string, readonly string[]>();
const catalog = new Map<string, Map<string, Column>>();
const baseOf = (declared: string): Base | undefined => {
  const d = declared.toLowerCase();
  if (d === "integer" || d === "int") return "int";
  if (d === "real" || d === "double" || d === "float") return "real";
  if (d === "text") return "text";
  if (d === "boolean") return "bool";
  return undefined;
};
for (const row of sqlite.prepare("select name, sql from sqlite_master where type in ('table', 'view') and sql is not null").all()) {
  const name = String(row.name);
  const sql = String(row.sql);
  if (/^create virtual table/iu.test(sql) || name.startsWith("sqlite_") || /_(data|idx|content|docsize|config)$/u.test(name)) continue;
  const checks = new Map<string, string[]>();
  for (const m of sql.matchAll(/check \((\w+) in \(([^)]*)\)\)/giu))
    checks.set(
      m[1] ?? "",
      [...(m[2] ?? "").matchAll(/'([^']*)'/gu)].map((w) => w[1] ?? ""),
    );
  const columns = new Map<string, Column>();
  for (const row of sqlite.prepare(`pragma table_info("${name}")`).all()) {
    const info = { name: String(row.name), type: String(row.type), notnull: Number(row.notnull), pk: Number(row.pk) };
    const base = baseOf(info.type);
    if (!base) continue;
    const set = checks.get(info.name);
    let named: string | undefined;
    if (set && base === "text") {
      named = `Sqlite_${name}_${info.name}`;
      words.set(named, set);
    }
    columns.set(info.name, { type: { base, nullable: info.notnull === 0 && info.pk === 0, ...(named ? { words: named } : {}) } });
  }
  catalog.set(name, columns);
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
    const body = at.body.join("\n").trim();
    out.push({ file, line: at.line, name: at.name, kind: at.kind, text: body });
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

const castBase = (word: string): Base | undefined => {
  switch (word.toLowerCase()) {
    case "int":
    case "integer":
    case "bigint":
      return "int";
    case "real":
    case "float8":
    case "double":
      return "real";
    case "text":
      return "text";
    case "bool":
    case "boolean":
      return "bool";
    case "json":
    case "jsonb":
      return "json";
    case "text[]":
      return "text[]";
    case "int[]":
      return "int[]";
    default:
      return undefined;
  }
};

/** The SQL a cast of operand to base is in SQLite. */
const castSql = (operand: string, base: Base) =>
  base === "int" ? `cast(${operand} as integer)` : base === "real" ? `cast(${operand} as real)` : base === "text" ? `cast(${operand} as text)` : operand;

/** Where the operand before a :: at end starts: a call or a parenthesized group, a string, or a dotted name. */
function operandStart(code: string, end: number): number {
  let i = end;
  if (code[i - 1] === ")") {
    let depth = 0;
    for (i -= 1; i >= 0; i -= 1) {
      if (code[i] === ")") depth += 1;
      else if (code[i] === "(") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    while (i > 0 && /[\w.]/u.test(code[i - 1] ?? "")) i -= 1;
    return i;
  }
  if (code[i - 1] === "'") {
    i -= 2;
    while (i >= 0 && code[i] !== "'") i -= 1;
    return i;
  }
  while (i > 0 && /[\w."]/u.test(code[i - 1] ?? "")) i -= 1;
  return i;
}

interface Param {
  readonly name: string;
  nullable: boolean;
  type?: Base;
  words?: string;
}

interface Rewritten {
  readonly sql: string;
  readonly params: Param[];
  /** Result columns typed in the query (expr::T as name). */
  readonly hints: Map<string, Type>;
}

function rewrite(q: Query): Rewritten {
  const params: Param[] = [];
  const hints = new Map<string, Type>();
  // Comment lines are set aside while the code is read, so a parenthesis or a sqlc.arg in one is not taken for code.
  const comments: string[] = [];
  let code = q.text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? `/*comment ${comments.push(line) - 1}*/` : line))
    .join("\n");
  if (/\$\d/u.test(code)) problem(`${q.file}:${q.line} ${q.name}`, "a $N parameter has no name", "write sqlc.arg(<column>) instead");
  code = code.replace(/sqlc\.(n?arg)\((\w+)\)((?:::[a-z0-9]+(?:\[\])?)*)/giu, (_whole, kind: string, name: string, casts: string) => {
    let p = params.find((x) => x.name === name);
    if (!p) {
      p = { name, nullable: kind.toLowerCase() === "narg" };
      params.push(p);
    }
    const chain = casts.split("::").filter((c) => c !== "");
    const first = chain[0] ? castBase(chain[0]) : undefined;
    if (chain[0] && !first)
      problem(
        `${q.file}:${q.line} ${q.name}`,
        `sqlc.arg(${name})::${chain[0]} is no type this generator knows`,
        "write ::int, ::real, ::text, ::bool, ::text[] or ::int[]",
      );
    if (first && !p.type) p.type = first;
    let out = `?${params.indexOf(p) + 1}`;
    for (const c of chain.slice(1)) {
      const base = castBase(c);
      if (base) out = castSql(out, base);
    }
    return out;
  });
  // Casts on anything else, leftmost first: the operand before it holds no cast any more.
  for (let m = /::([a-z0-9_]+(?:\.[a-z0-9_]+|\[\])?)(\?)?/iu.exec(code); m; m = /::([a-z0-9_]+(?:\.[a-z0-9_]+|\[\])?)(\?)?/iu.exec(code)) {
    const [table, column] = (m[1] ?? "").split(".");
    const like = table && column ? catalog.get(table)?.get(column) : undefined;
    const base = like ? like.type.base : castBase(m[1] ?? "");
    const start = operandStart(code, m.index);
    if (!base || start < 0) {
      problem(
        `${q.file}:${q.line} ${q.name}`,
        `::${m[1]} is no cast this generator reads`,
        "write ::int, ::real, ::text, ::bool or ::json after a name, a call or a parenthesized expression",
      );
      break;
    }
    const operand = code.slice(start, m.index);
    const after = code.slice(m.index + m[0].length);
    const named = /^\s+as\s+"?(\w+)"?/iu.exec(after);
    if (named) hints.set(named[1] ?? "", { base, nullable: m[2] === "?", ...(like?.type.words ? { words: like.type.words } : {}) });
    code = code.slice(0, start) + (like ? operand : castSql(operand, base)) + after;
  }
  for (const m of code.matchAll(/\bcount\((?:\*|[\w.]+|distinct [\w.]+)\)\s+as\s+(\w+)/giu))
    if (!hints.has(m[1] ?? "")) hints.set(m[1] ?? "", { base: "int", nullable: false });
  const sql = code.replace(/\/\*comment (\d+)\*\//gu, (_whole, i: string) => comments[Number(i)] ?? "");
  return { sql, params, hints };
}

const keywords = new Set([
  "where",
  "join",
  "left",
  "inner",
  "on",
  "set",
  "left",
  "inner",
  "join",
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

/** The tables a query names, by alias and by name; the ones left joined, whose columns may be null. */
function tablesOf(sql: string) {
  const byAlias = new Map<string, string>();
  const outer = new Set<string>();
  const notAlias = [...keywords].join("|");
  for (const m of sql.matchAll(new RegExp(`\\b(from|join|update|into)\\s+(\\w+)(?:\\s+(?:as\\s+)?(?!(?:${notAlias})\\b)(\\w+))?`, "giu"))) {
    const table = m[2] ?? "";
    if (!catalog.has(table)) continue;
    byAlias.set(table, table);
    const alias = m[3];
    if (alias && !keywords.has(alias.toLowerCase())) byAlias.set(alias, table);
    const before = sql.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if ((m[1] ?? "").toLowerCase() === "join" && /left\s+(outer\s+)?$/u.test(before)) outer.add(alias && !keywords.has(alias.toLowerCase()) ? alias : table);
  }
  return { byAlias, outer };
}

function columnOf(sql: string, ref: string, tables: ReturnType<typeof tablesOf>): Column | undefined {
  const [first = "", second] = ref.split(".");
  if (second) {
    const table = first === "excluded" ? /insert into (\w+)/iu.exec(sql)?.[1] : tables.byAlias.get(first);
    return table ? catalog.get(table)?.get(second) : undefined;
  }
  for (const table of new Set(tables.byAlias.values())) {
    const c = catalog.get(table)?.get(first);
    if (c) return c;
  }
  return undefined;
}

/** Each parameter's type from the column it is compared with, inserted into or set to; limit and offset are ints. */
function inferParams(q: Query, r: Rewritten) {
  const tables = tablesOf(r.sql);
  const set = (p: Param, c: Column | undefined, nullable: boolean) => {
    if (!c || p.type) return;
    p.type = c.type.base;
    if (c.type.words) p.words = c.type.words;
    if (nullable && c.type.nullable) p.nullable = true;
  };
  r.params.forEach((p, i) => {
    const n = `\\?${i + 1}(?!\\d)`;
    const ref = "((?:\\w+\\.)?\\w+)";
    const op = "(?:=|<>|!=|<=|>=|<|>|\\bis not\\b|\\bis\\b|\\blike\\b)";
    if (new RegExp(`\\b(limit|offset)\\s+${n}`, "iu").test(r.sql)) p.type ??= "int";
    if (new RegExp(`\\bnot\\s+${n}`, "iu").test(r.sql)) p.type ??= "bool";
    const insert = /insert into (\w+)\s*\(([^)]*)\)\s*values\s*\(/iu.exec(r.sql);
    if (insert) {
      const columns = (insert[2] ?? "").split(",").map((c) => c.trim());
      const values = splitTop(r.sql.slice(insert.index + insert[0].length));
      values.forEach((v, j) => {
        if (new RegExp(`^\\s*${n}\\s*$`, "u").test(v)) set(p, catalog.get(insert[1] ?? "")?.get(columns[j] ?? ""), true);
      });
    }
    for (const m of r.sql.matchAll(new RegExp(`\\bset\\b[^;]*?\\b${ref}\\s*=\\s*${n}`, "giu"))) set(p, columnOf(r.sql, m[1] ?? "", tables), true);
    for (const m of r.sql.matchAll(new RegExp(`,\\s*${ref}\\s*=\\s*${n}`, "giu"))) set(p, columnOf(r.sql, m[1] ?? "", tables), true);
    for (const m of r.sql.matchAll(new RegExp(`${ref}\\s*${op}\\s*${n}`, "giu"))) set(p, columnOf(r.sql, m[1] ?? "", tables), false);
    for (const m of r.sql.matchAll(new RegExp(`${n}\\s*${op}\\s*${ref}`, "giu"))) set(p, columnOf(r.sql, m[1] ?? "", tables), false);
    for (const m of r.sql.matchAll(new RegExp(`\\b(?:max|min|coalesce)\\(\\s*${ref}\\s*,\\s*${n}`, "giu"))) set(p, columnOf(r.sql, m[1] ?? "", tables), false);
    if (!p.type)
      problem(
        `${q.file}:${q.line} ${q.name}`,
        `the type of sqlc.arg(${p.name}) cannot be read from the query`,
        `write sqlc.arg(${p.name})::int (or ::real, ::text, ::bool, ::text[])`,
      );
  });
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

interface ResultColumn {
  readonly name: string;
  readonly type: Type;
}

function resultOf(q: Query, r: Rewritten): ResultColumn[] {
  let columns: { name: string; table: string | null; column: string | null }[];
  try {
    columns = sqlite.prepare(r.sql).columns();
  } catch (e) {
    problem(`${q.file}:${q.line} ${q.name}`, `SQLite does not take it: ${e instanceof Error ? e.message : String(e)}`, "write it in SQLite's dialect");
    return [];
  }
  if (q.kind === "exec") return [];
  const tables = tablesOf(r.sql);
  const outerTables = new Set([...tables.outer].map((a) => tables.byAlias.get(a)));
  return columns.map((c) => {
    const hint = r.hints.get(c.name);
    if (hint) return { name: c.name, type: hint };
    const known = c.table && c.column ? catalog.get(c.table)?.get(c.column) : undefined;
    if (known) {
      const left =
        c.table !== null && outerTables.has(c.table) && ![...tables.byAlias.entries()].some(([a, t]) => t === c.table && !tables.outer.has(a) && a !== t);
      return { name: c.name, type: { ...known.type, nullable: known.type.nullable || left } };
    }
    problem(
      `${q.file}:${q.line} ${q.name}`,
      `the result column ${c.name} is computed, so SQLite cannot say its type`,
      `write it as <expr>::int as ${c.name} (or ::real, ::text, ::bool; ::int? when it may be null)`,
    );
    return { name: c.name, type: { base: "text", nullable: true } };
  });
}

const schemaOf = (t: Type & { words?: string }) => {
  const base =
    t.words ??
    (t.base === "int"
      ? "Schema.Int"
      : t.base === "real"
        ? "Schema.Number"
        : t.base === "bool"
          ? "SqliteBoolean"
          : t.base === "text[]"
            ? "Schema.fromJsonString(Schema.Array(Schema.String))"
            : t.base === "int[]"
              ? "Schema.fromJsonString(Schema.Array(Schema.Int))"
              : "Schema.String");
  return t.nullable ? `Schema.NullOr(${base})` : base;
};

const reserved = new Set(["in", "then", "delete", "new", "default", "function", "class", "return", "import", "export", "for", "if", "do", "case"]);
const fnName = (name: string) => {
  const lower = (name[0] ?? "").toLowerCase() + name.slice(1);
  return reserved.has(lower) ? `${lower}_` : lower;
};

const made = new Map<string, string>();
const usedWords = new Set<string>();
for (const file of readdirSync(join(db, "queries"))
  .filter((f) => f.endsWith(".sql"))
  .toSorted()) {
  const parts: string[] = [];
  const imports = new Set<string>();
  for (const q of queriesOf(file)) {
    const r = rewrite(q);
    inferParams(q, r);
    const result = resultOf(q, r);
    const paramTypes = r.params.map((p) => ({ name: p.name, type: { base: p.type ?? "text", nullable: p.nullable, ...(p.words ? { words: p.words } : {}) } }));
    for (const t of [...paramTypes.map((p) => p.type), ...result.map((c) => c.type)]) {
      if (t.words) imports.add(t.words);
      if (t.base === "bool" && !t.words) imports.add("SqliteBoolean");
    }
    const field = (name: string, t: Type) => `  ["${name}"]: ${schemaOf(t)},`;
    parts.push(
      `export const ${q.name}Params = Schema.Struct({\n${paramTypes.map((p) => field(p.name, p.type)).join("\n")}\n})\nexport type ${q.name}Params = typeof ${q.name}Params.Type\n\n`,
    );
    if (q.kind !== "exec")
      parts.push(
        `export const ${q.name}Result = Schema.Struct({\n${result.map((c) => field(c.name, c.type)).join("\n")}\n})\nexport type ${q.name}Result = typeof ${q.name}Result.Type\n\n`,
      );
    parts.push(`export const ${q.name}Sql = ${JSON.stringify(r.sql)}\n`);
    const call = q.kind === "exec" ? "void" : q.kind === "one" ? "findOne" : "findAll";
    const args = `[${r.params.map((p) => `p["${p.name}"]`).join(", ")}]`;
    const none = r.params.length === 0;
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
    `// Generated by scripts/sqlite-generate.ts. DO NOT EDIT.\n// Source: ${file}\n\nimport { Effect, Schema } from "effect"\nimport { SqlClient, SqlSchema } from "effect/sql"\n${typesLine}\n${parts.join("\n")}`,
  );
}

made.set(
  "types.ts",
  `// Generated by scripts/sqlite-generate.ts. DO NOT EDIT.\nimport { Schema, SchemaGetter } from "effect"\n\n` +
    `/** A boolean as SQLite keeps it: 0 or 1. */\nexport const SqliteBoolean = Schema.Number.pipe(\n  Schema.decodeTo(Schema.Boolean, { decode: SchemaGetter.transform((n: number) => n !== 0), encode: SchemaGetter.transform((b: boolean) => (b ? 1 : 0)) }),\n)\n\n` +
    [...words.entries()]
      .filter(([name]) => usedWords.has(name))
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, set]) => `export const ${name} = Schema.Literals(${JSON.stringify(set)})\nexport type ${name} = typeof ${name}.Type\n`)
      .join("\n"),
);

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
