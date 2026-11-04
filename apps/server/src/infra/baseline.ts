// The database's baseline (db/migrations/0001_schema.up.sql) and its hash, which a database is marked with
// (<folder>.schema): a database made from another one is set aside (db.ts). The desktop's package script reads it too, to
// say in a release whether it starts a new farm; so this file imports nothing of the server's but where its files are.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { serverFile } from "#/assets.ts";

const baselineFile = serverFile("db/migrations/0001_schema.up.sql");
const baselineSql = () => readFileSync(baselineFile, "utf8");
export const baselineHash = () => createHash("sha256").update(baselineSql()).digest("hex").slice(0, 16);

/** The baseline as single statements, in order: SQLite prepares one at a time. A trigger's body (BEGIN … END;) stays
 * one statement; quotes and comments are read past. */
export function baselineStatements(sql: string = baselineSql()): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const code = (text: string) => text.replace(/--[^\n]*/gu, "").trim();
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    cur += ch;
    i += 1;
    if (ch !== ";") continue;
    const text = code(cur);
    if (/^create\s+trigger/iu.test(text) && !/\bend\s*;$/iu.test(text)) continue;
    if (text !== ";") out.push(cur.trim());
    cur = "";
  }
  if (code(cur) !== "") out.push(cur.trim());
  return out;
}
