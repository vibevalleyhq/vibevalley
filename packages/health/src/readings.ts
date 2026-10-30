/**
 * Readings of a repository's health, as pure functions of what collect.ts reads: the commits with their files, and the
 * source as it is now. A reading points at where to look; it is not a verdict on the code there. What counts and how
 * files group into areas is the repository's own (its Health config), so nothing here knows one repository's layout.
 */

import { parseSync } from "vite";

const day = 86_400_000;

/** A repository's say in its readings. */
export interface Health {
  /** The production code the readings look at: tests, stories, fixtures and generated files are the repository's to leave out. */
  readonly counted: (path: string) => boolean;
  /** The area a file's counts are kept under (a module, a feature, a package). */
  readonly areaOf: (path: string) => string;
  /** Files that are hot by design, each with the reason; one that no longer exists is a stale reason. */
  readonly hotByDesign: Readonly<Record<string, string>>;
  /** The kept escape counts, relative to the repository's root. */
  readonly ratchet: string;
  /** The hotspot window, days. */
  readonly days: number;
}

/** A commit as git log --name-status -M lists it, newest first. */
export interface RawCommit {
  readonly sha: string;
  /** Its commit time, ms. */
  readonly at: number;
  readonly entries: readonly { readonly path: string; readonly from?: string }[];
}

/** A commit with its files under today's names. */
export interface Change {
  readonly sha: string;
  readonly at: number;
  readonly files: readonly string[];
}

export interface Source {
  readonly path: string;
  readonly text: string;
}

/** A change touching more files than this is mechanical (a format, a rewrite or rename across the tree): its files did not
 * each get work. Squashed feature PRs here touch up to ~400 files (tests, catalogs, stories with the code). */
export const mechanicalFiles = 500;

/** Each file under the name it has at the newest commit: newest first, a rename maps every older mention of the old name. */
export function underTodaysNames(commits: readonly RawCommit[]): Change[] {
  const today = new Map<string, string>();
  const nameOf = (path: string) => today.get(path) ?? path;
  return commits.map((c) => {
    const files = c.entries.map((e) => nameOf(e.path));
    for (const e of c.entries) if (e.from !== undefined) today.set(e.from, nameOf(e.path));
    return { sha: c.sha, at: c.at, files: [...new Set(files)] };
  });
}

const lineCount = (text: string) => text.split("\n").length;

export interface Hotspot {
  readonly path: string;
  /** Changes in the window ending now, and in the window before it. */
  readonly changes: number;
  readonly before: number;
  readonly lines: number;
  /** changes × lines: a big file that keeps changing is where a change most often goes wrong and a split pays most. */
  readonly score: number;
}

/** Each counted file's changes over the last `days` against the `days` before; mechanical changes are not counted. */
export function hotspots(changes: readonly Change[], sources: readonly Source[], now: number, days: number, counted: Health["counted"]): Hotspot[] {
  const recent = new Map<string, number>();
  const earlier = new Map<string, number>();
  for (const c of changes) {
    if (c.files.length > mechanicalFiles) continue;
    const window = c.at > now - days * day ? recent : c.at > now - 2 * days * day ? earlier : undefined;
    if (window) for (const f of c.files) window.set(f, (window.get(f) ?? 0) + 1);
  }
  return sources
    .flatMap((s) => {
      const n = recent.get(s.path);
      if (n === undefined || !counted(s.path)) return [];
      const lines = lineCount(s.text);
      return [{ path: s.path, changes: n, before: earlier.get(s.path) ?? 0, lines, score: n * lines }];
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
}

/** Where a check is turned off by hand. */
export interface Escapes {
  /** x!: the type checker is told a value is there. */
  readonly nonNull: number;
  /** x as unknown as T: the type checker is told a value is another type. */
  readonly doubleCast: number;
  /** x as T: the type checker takes a value as T unchecked (as const, as unknown and double casts aside). */
  readonly cast: number;
  /** A comment that turns a lint rule off. */
  readonly lintOff: number;
}

export const escapeKinds = ["nonNull", "doubleCast", "cast", "lintOff"] as const satisfies readonly (keyof Escapes)[];

type Node = { readonly type?: unknown; readonly [key: string]: unknown };
/** Any object is a Node: every field is read as unknown. */
const nodeOf = (v: unknown): Node => (typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {});

export function escapesIn(path: string, text: string): Escapes {
  const parsed = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" });
  let nonNull = 0;
  let doubleCast = 0;
  let cast = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    const node = nodeOf(value);
    if (node.type === "TSNonNullExpression") nonNull++;
    if (node.type === "TSAsExpression") {
      const inner = nodeOf(node.expression);
      const to = nodeOf(node.typeAnnotation);
      const toConst = to.type === "TSTypeReference" && nodeOf(to.typeName).name === "const";
      if (inner.type === "TSAsExpression" && nodeOf(inner.typeAnnotation).type === "TSUnknownKeyword") doubleCast++;
      else if (!toConst && to.type !== "TSUnknownKeyword") cast++;
    }
    for (const key in node) if (key !== "parent") visit(node[key]);
  };
  visit(parsed.program);
  const lintOff = parsed.comments.filter((c) => /^\s*(?:oxlint|eslint)-disable/.test(c.value)).length;
  return { nonNull, doubleCast, cast, lintOff };
}

/** The escapes of the counted sources, summed by area, areas in order. */
export function escapesByArea(sources: readonly Source[], health: Pick<Health, "counted" | "areaOf">): Record<string, Escapes> {
  const out: Record<string, Record<keyof Escapes, number>> = {};
  for (const s of sources) {
    if (!health.counted(s.path)) continue;
    const e = escapesIn(s.path, s.text);
    const area = (out[health.areaOf(s.path)] ??= { nonNull: 0, doubleCast: 0, cast: 0, lintOff: 0 });
    for (const k of escapeKinds) area[k] += e[k];
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** A count off the ratchet: up is new escapes, down is a ratchet left loose. */
export interface Drift {
  readonly area: string;
  readonly kind: keyof Escapes;
  readonly kept: number;
  readonly now: number;
}

/** Every count that differs from the kept one; an area that is gone counts zero now, a new one zero kept. */
export function drift(kept: Readonly<Record<string, Escapes>>, now: Readonly<Record<string, Escapes>>): Drift[] {
  const areas = [...new Set([...Object.keys(kept), ...Object.keys(now)])].sort();
  return areas.flatMap((area) =>
    escapeKinds.flatMap((kind) => {
      const k = kept[area]?.[kind] ?? 0;
      const n = now[area]?.[kind] ?? 0;
      return k === n ? [] : [{ area, kind, kept: k, now: n }];
    }),
  );
}
