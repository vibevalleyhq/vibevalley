import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

/** Which server module uses which member of another module's service, read from syntax: `const x = yield* Service`
 * binds x in that file, `x.member` is a use. Kept in scripts/service-paths.json; a new edge is a new path to that
 * member, and it has to be written down on purpose (.agents/notes/proposed/architecture/2026-11-09-converge-paths.md).
 *
 * Not seen: a service destructured from its yield, or handed on as a port or a parameter. Those are missed, never
 * reported wrongly. */

type Node = { readonly type?: unknown; readonly start?: number; readonly [key: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v) && "type" in v && typeof v.type === "string";
const walk = (node: Node, visit: (n: Node) => void) => {
  visit(node);
  for (const key in node) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v.filter(isNode)) walk(c, visit);
    else if (isNode(v)) walk(v, visit);
  }
};
const identName = (n: unknown): string | undefined => (isNode(n) && n.type === "Identifier" && typeof n["name"] === "string" ? n["name"] : undefined);

const root = "apps/server/src/";
/** Handlers only forward (AGENTS.md); the ground (infra, base) is everyone's. */
const outerCallers = new Set(["http"]);
const ground = new Set(["infra", "base"]);
const skipped = /\.(test|spec)\.ts$|\/testing\/|\/testdata\/|\.d\.ts$/u;

/** A file's module: the folder under apps/server/src it sits in; undefined for the files at the top (services.ts). */
export const moduleOf = (path: string): string | undefined => {
  const rest = path.startsWith(root) ? path.slice(root.length) : undefined;
  const [first, ...more] = rest?.split("/") ?? [];
  return more.length > 0 ? first : undefined;
};

export type Edges = Readonly<Record<string, readonly string[]>>;

/** Service.member → the modules other than the service's own that use it, both sorted. */
export function edgesOf(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Edges {
  const programs = files.flatMap(({ path, text }) => {
    const program: unknown = parseSync(path, text, { lang: "ts" }).program;
    return isNode(program) ? [{ path, program }] : [];
  });
  const owner = new Map<string, string>();
  for (const { path, program } of programs)
    walk(program, (n) => {
      if (n.type !== "ClassDeclaration") return;
      const name = identName(n["id"]);
      const module = moduleOf(path);
      const base = n["superClass"];
      if (name !== undefined && module !== undefined && isNode(base) && JSON.stringify(base).includes('"Service"')) owner.set(name, module);
    });
  const edges = new Map<string, Set<string>>();
  for (const { path, program } of programs) {
    const module = moduleOf(path);
    if (module === undefined || outerCallers.has(module) || skipped.test(path)) continue;
    const bound = new Map<string, string>();
    walk(program, (n) => {
      if (n.type !== "VariableDeclarator") return;
      const init = n["init"];
      const variable = identName(n["id"]);
      if (variable === undefined || !isNode(init) || init.type !== "YieldExpression" || init["delegate"] !== true) return;
      const service = identName(init["argument"]);
      if (service !== undefined && owner.has(service)) bound.set(variable, service);
    });
    walk(program, (n) => {
      if (n.type !== "MemberExpression" && n.type !== "StaticMemberExpression") return;
      const service = bound.get(identName(n["object"]) ?? "");
      const member = identName(n["property"]);
      const home = service === undefined ? undefined : owner.get(service);
      if (service === undefined || member === undefined || home === undefined || home === module || ground.has(home)) return;
      const key = `${service}.${member}`;
      edges.set(key, (edges.get(key) ?? new Set()).add(module));
    });
  }
  return Object.fromEntries([...edges.keys()].toSorted().map((k) => [k, [...(edges.get(k) ?? [])].toSorted()]));
}

/** What is wrong with today's edges against the kept ones (empty when nothing). */
export function pathProblems(kept: Edges, now: Edges): string[] {
  const problems: string[] = [];
  for (const key of [...new Set([...Object.keys(kept), ...Object.keys(now)])].toSorted()) {
    const was = new Set(kept[key] ?? []);
    const is = new Set(now[key] ?? []);
    for (const m of is)
      if (!was.has(m))
        problems.push(
          `${m} now uses ${key}, a path the table does not have. Fix: reach it through the door this module already uses ` +
            `(the modules that use ${key} today: ${[...was].join(", ") || "none"}); if this module really is a new caller, \`vp run paths:write\` ` +
            `and say why in the PR. See .agents/notes/proposed/architecture/2026-11-09-converge-paths.md`,
        );
    for (const m of was)
      if (!is.has(m)) problems.push(`${m} no longer uses ${key}. Fix: \`vp run paths:write\` takes the path off the table, so it cannot come back unnoticed.`);
  }
  return problems;
}

export const tablePath = "scripts/service-paths.json";

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: "boolean" }, write: { type: "boolean" } } });
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", root], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p.endsWith(".ts"));
  const now = edgesOf(paths.map((path) => ({ path, text: readFileSync(path, "utf8") })));
  if (values.write === true) writeFileSync(tablePath, JSON.stringify(now, null, 2) + "\n");
  if (values.check === true || values.write === true) {
    const kept: Edges = JSON.parse(readFileSync(tablePath, "utf8"));
    const problems = pathProblems(kept, now);
    for (const p of problems) console.error(`paths: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`paths: ${Object.keys(now).length} service members used across modules, no new path`);
  } else for (const [key, modules] of Object.entries(now)) console.log(`${key.padEnd(40)} ${modules.join(", ")}`);
}
