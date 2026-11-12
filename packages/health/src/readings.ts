import { parseSync } from "vite";

const day = 86_400_000;

export interface Health {
  readonly counted: (path: string) => boolean;
  readonly areaOf: (path: string) => string;
  /** Stale paths that no longer exist fail verification. */
  readonly hotByDesign: Readonly<Record<string, string>>;
  readonly ratchet: string;
  readonly days: number;
}

export interface RawCommit {
  readonly sha: string;
  readonly at: number;
  readonly entries: readonly { readonly path: string; readonly from?: string }[];
}

export interface Change {
  readonly sha: string;
  readonly at: number;
  readonly files: readonly string[];
}

export interface Source {
  readonly path: string;
  readonly text: string;
}

/** Commits touching more files than this are ignored as tree-wide mechanical sweeps. */
export const mechanicalFiles = 500;

/** Expects `commits` newest-first so rename chains resolve to current paths. */
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
  readonly changes: number;
  readonly before: number;
  readonly lines: number;
  readonly score: number;
}

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
    .toSorted((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
}

export interface Escapes {
  readonly nonNull: number;
  readonly doubleCast: number;
  readonly cast: number;
  readonly lintOff: number;
  /** A failure dropped on the spot: an empty `catch {}`, `.catch(() => {})`, `.then(ok, () => undefined)`. */
  readonly swallowed: number;
}

export const escapeKinds = ["nonNull", "doubleCast", "cast", "lintOff", "swallowed"] as const satisfies readonly (keyof Escapes)[];

export const escapeAdvice: Record<keyof Escapes, string> = {
  nonNull: "narrow the value (if (x === undefined) …, ?. or ??) so the type checker sees it is there",
  doubleCast: "decode the value (a Zod schema, a type guard) instead of telling the type checker it is another type",
  cast: "decode or narrow the value; a type the checker should infer is fixed where it is made, not where it is read",
  lintOff: "write it the way the rule asks; its message says how",
  swallowed: "catch only what is expected (instanceof) and rethrow the rest, or log it and say at the catch why it is safe to go on",
};

type Node = { readonly type?: unknown; readonly [key: string]: unknown };
const nodeOf = (v: unknown): Node => (typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {});

/** A function, or a catch block, that does nothing with what it is given. */
const isEmpty = (fn: Node) => {
  const body = nodeOf(fn.body);
  if (body.type === "BlockStatement") return Array.isArray(body.body) && body.body.length === 0;
  if (body.type === "Identifier") return body.name === "undefined";
  if (body.type === "Literal") return body.value === null;
  return body.type === "UnaryExpression" && body.operator === "void";
};
const isFunction = (n: Node | undefined) => n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";
const memberName = (n: Node) => (n.type === "MemberExpression" ? nodeOf(n.property).name : undefined);

export function escapesIn(path: string, text: string): Escapes {
  const parsed = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" });
  let nonNull = 0;
  let doubleCast = 0;
  let cast = 0;
  let swallowed = 0;
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
    if (node.type === "CatchClause" && isEmpty({ body: node.body })) swallowed++;
    if (node.type === "CallExpression") {
      const name = memberName(nodeOf(node.callee));
      const args = Array.isArray(node.arguments) ? node.arguments.map(nodeOf) : [];
      const handler = name === "catch" ? args[0] : name === "then" ? args[1] : undefined;
      if (handler && isFunction(handler) && isEmpty(handler)) swallowed++;
    }
    for (const key in node) if (key !== "parent") visit(node[key]);
  };
  visit(parsed.program);
  const lintOff = parsed.comments.filter((c) => /^\s*(?:oxlint|eslint)-disable/u.test(c.value)).length;
  return { nonNull, doubleCast, cast, lintOff, swallowed };
}

export function escapesByArea(sources: readonly Source[], health: Pick<Health, "counted" | "areaOf">): Record<string, Escapes> {
  const out: Record<string, Record<keyof Escapes, number>> = {};
  for (const s of sources) {
    if (!health.counted(s.path)) continue;
    const e = escapesIn(s.path, s.text);
    const area = (out[health.areaOf(s.path)] ??= { nonNull: 0, doubleCast: 0, cast: 0, lintOff: 0, swallowed: 0 });
    for (const k of escapeKinds) area[k] += e[k];
  }
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)));
}

export interface Drift {
  readonly area: string;
  readonly kind: keyof Escapes;
  readonly kept: number;
  readonly now: number;
}

export function drift(kept: Readonly<Record<string, Escapes>>, now: Readonly<Record<string, Escapes>>): Drift[] {
  const areas = [...new Set([...Object.keys(kept), ...Object.keys(now)])].toSorted();
  return areas.flatMap((area) =>
    escapeKinds.flatMap((kind) => {
      const k = kept[area]?.[kind] ?? 0;
      const n = now[area]?.[kind] ?? 0;
      return k === n ? [] : [{ area, kind, kept: k, now: n }];
    }),
  );
}
