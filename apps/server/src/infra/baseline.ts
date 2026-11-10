import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { serverFile } from "#/base/assets.ts";

const baselineFile = serverFile("db/migrations/0001_schema.up.sql");
export const baselineSql = () => readFileSync(baselineFile, "utf8");
export const baselineHash = () => createHash("sha256").update(baselineSql()).digest("hex").slice(0, 16);

/** The baseline as single statements, in order: a driver prepares one at a time. A function's body ($$ … $$) and a
 * string stay inside the statement they are in. */
export function baselineStatements(sql: string = baselineSql()): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const code = (text: string) => text.replace(/--[^\n]*/gu, "").trim();
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === undefined) break;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "$" && sql[i + 1] === "$") {
      const end = sql.indexOf("$$", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
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
    if (code(cur) !== ";") out.push(cur.trim());
    cur = "";
  }
  if (code(cur) !== "") out.push(cur.trim());
  return out;
}
