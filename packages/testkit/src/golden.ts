import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { Option, Result, Schema } from "effect";

export interface Case {
  readonly line: number;
  readonly fn: string;
  readonly in: unknown;
  readonly out: unknown;
}

/** The file each case came from: an update writes its answer back there. */
const sources = new WeakMap<Case, string>();

/** A line of a golden file. Its keys are in the order the files hold them, so a rewritten row is the same text. */
const Row = Schema.fromJsonString(Schema.Struct({ fn: Schema.String, in: Schema.Unknown, out: Schema.Unknown }));
const Json = Schema.fromJsonString(Schema.Unknown);

/** What JSON.stringify gives, and "undefined" where it gives nothing. */
const shown = (v: unknown) => Option.getOrElse(Schema.encodeOption(Json)(v), () => String(v));

/** The value as JSON holds it: a key holding undefined is no key, a Date is its string. */
const throughJson = (v: unknown): unknown => Result.getOrThrow(Schema.decodeResult(Json)(Result.getOrThrow(Schema.encodeResult(Json)(v))));

const rowsOf = (path: string) =>
  gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => Result.getOrThrow(Schema.decodeResult(Row)(l)));

/** The cases of one file. */
export function goldenCasesAt(path: string): Case[] {
  return rowsOf(path).map((row, i) => {
    const c = { line: i + 1, fn: row.fn, in: row.in, out: row.out };
    sources.set(c, path);
    return c;
  });
}

/** Where got and want differ, as JSON (a key holding undefined is no key); undefined when they agree. */
export function jsonDiff(got: unknown, want: unknown, path = ""): string | undefined {
  const a: unknown = got === undefined ? null : throughJson(got);
  return diff(a, want ?? null, path);
}

function diff(a: unknown, b: unknown, path: string): string | undefined {
  if (a === b) return undefined;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return `${path || "."}: got ${shown(a).slice(0, 300)}, want ${shown(b).slice(0, 300)}`;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return `${path}: got ${shown(a).slice(0, 300)}, want ${shown(y).slice(0, 300)}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], y[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!(k in x)) return `${path}.${k}: missing, want ${shown(y[k]).slice(0, 200)}`;
    if (!(k in y)) return `${path}.${k}: got ${shown(x[k]).slice(0, 200)}, want none`;
    const d = diff(x[k], y[k], `${path}.${k}`);
    if (d) return d;
  }
  return undefined;
}

/** Runs every case through rule and collects the first disagreements. */
export function checkCases(cases: readonly Case[], rule: (c: Case) => unknown): string[] {
  if (process.env.VIBEVALLEY_GOLDEN === "update") {
    update(cases, rule);
    return [];
  }
  const failed: string[] = [];
  for (const c of cases) {
    if (failed.length >= 10) break;
    const d = jsonDiff(rule(c), c.out);
    if (d) failed.push(`line ${c.line} ${c.fn}(${shown(c.in).slice(0, 200)}): ${d}`);
  }
  return failed;
}

function update(cases: readonly Case[], rule: (c: Case) => unknown) {
  const byFile = new Map<string, Map<number, unknown>>();
  for (const c of cases) {
    const path = sources.get(c);
    if (!path) continue;
    const got = throughJson(rule(c) ?? null);
    if (jsonDiff(got, c.out) === undefined) continue;
    let lines = byFile.get(path);
    if (!lines) byFile.set(path, (lines = new Map()));
    lines.set(c.line, got);
  }
  for (const [path, outs] of byFile) {
    const rows = rowsOf(path).map((row, i) => (outs.has(i + 1) ? { ...row, out: outs.get(i + 1) } : row));
    writeFileSync(path, gzipSync(rows.map((r) => Result.getOrThrow(Schema.encodeResult(Row)(r))).join("\n") + "\n"));
  }
}
