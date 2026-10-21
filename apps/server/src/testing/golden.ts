// The rules' recorded cases (src/<package>/testdata/*.jsonl.gz, first recorded from the server's Go version): each a
// rule's input and what it made of it, compared as JSON.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export interface Case {
  readonly line: number;
  readonly fn: string;
  readonly in: unknown;
  readonly out: unknown;
}

/** The file each case came from: an update writes its answer back there. */
const sources = new WeakMap<Case, string>();

const rowsOf = (path: string) =>
  gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { fn: string; in: unknown; out: unknown });

/** The cases of a package's file, by the package's folder under src. */
export function goldenCases(pkg: string, file = "rules.jsonl.gz"): Case[] {
  const path = resolve(import.meta.dirname, "..", pkg, "testdata", file);
  return rowsOf(path).map((row, i) => {
    const c = { line: i + 1, fn: row.fn, in: row.in, out: row.out };
    sources.set(c, path);
    return c;
  });
}

/** Where got and want differ, as JSON (a key holding undefined is no key); undefined when they agree. */
export function jsonDiff(got: unknown, want: unknown, path = ""): string | undefined {
  const a: unknown = got === undefined ? null : JSON.parse(JSON.stringify(got));
  return diff(a, want ?? null, path);
}

function diff(a: unknown, b: unknown, path: string): string | undefined {
  if (a === b) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return `${path || "."}: got ${JSON.stringify(a)?.slice(0, 300)}, want ${JSON.stringify(b)?.slice(0, 300)}`;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return `${path}: got ${JSON.stringify(a).slice(0, 300)}, want ${JSON.stringify(y).slice(0, 300)}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], y[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!(k in x)) return `${path}.${k}: missing, want ${JSON.stringify(y[k])?.slice(0, 200)}`;
    if (!(k in y)) return `${path}.${k}: got ${JSON.stringify(x[k])?.slice(0, 200)}, want none`;
    const d = diff(x[k], y[k], `${path}.${k}`);
    if (d) return d;
  }
  return undefined;
}

/** Runs every case through rule and collects the first disagreements. With VIBEVALLEY_GOLDEN=update, a rule changed on
 * purpose writes its answers back over the recorded ones instead (look at the diff before keeping it). */
export function checkCases(cases: readonly Case[], rule: (c: Case) => unknown): string[] {
  if (process.env.VIBEVALLEY_GOLDEN === "update") {
    update(cases, rule);
    return [];
  }
  const failed: string[] = [];
  for (const c of cases) {
    if (failed.length >= 10) break;
    const d = jsonDiff(rule(c), c.out);
    if (d) failed.push(`line ${c.line} ${c.fn}(${JSON.stringify(c.in)?.slice(0, 200)}): ${d}`);
  }
  return failed;
}

function update(cases: readonly Case[], rule: (c: Case) => unknown) {
  const byFile = new Map<string, Map<number, unknown>>();
  for (const c of cases) {
    const path = sources.get(c);
    if (!path) continue;
    const got: unknown = JSON.parse(JSON.stringify(rule(c) ?? null));
    if (jsonDiff(got, c.out) === undefined) continue;
    if (!byFile.has(path)) byFile.set(path, new Map());
    byFile.get(path)!.set(c.line, got);
  }
  for (const [path, outs] of byFile) {
    const rows = rowsOf(path).map((row, i) => (outs.has(i + 1) ? { ...row, out: outs.get(i + 1) } : row));
    writeFileSync(path, gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  }
}
