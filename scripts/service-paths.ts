import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

/** Which server module uses which member of another module's service, read from syntax: `const x = yield* Service`
 * binds x in that file, `x.member` is a use. Kept in scripts/service-paths.json; a new edge is a new path to that
 * member, and it has to be written down on purpose (docs/subsystems/foundation.md).
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
/** Leaf gateway/gamification services reached only by HTTP, Core's late-bound Projection, and Machine (staged for apps/machine). */
export const singleCallerServices = new Set(["Connector", "Game", "Lan", "Machine", "Mcp", "Projection", "Voice"]);

/** A file's module: the folder under apps/server/src it sits in; undefined for the files at the top (services.ts). */
export const moduleOf = (path: string): string | undefined => {
  const rest = path.startsWith(root) ? path.slice(root.length) : undefined;
  const [first, ...more] = rest?.split("/") ?? [];
  return more.length > 0 ? first : undefined;
};

export type Edges = Readonly<Record<string, readonly string[]>>;
export type FanIn = Readonly<Record<string, readonly string[]>>;

function parsedFiles(files: ReadonlyArray<{ readonly path: string; readonly text: string }>) {
  const programs = files.flatMap(({ path, text }) => {
    const program: unknown = parseSync(path, text, { lang: "ts" }).program;
    return isNode(program) ? [{ path, program }] : [];
  });
  const user = new Map<string, string>();
  for (const { path, program } of programs) {
    if (skipped.test(path)) continue;
    walk(program, (n) => {
      if (n.type !== "ClassDeclaration") return;
      const name = identName(n["id"]);
      const module = moduleOf(path);
      const base = n["superClass"];
      if (name !== undefined && module !== undefined && isNode(base) && JSON.stringify(base).includes('"Service"')) user.set(name, module);
    });
  }
  return { programs, user };
}

/** Service.member → the modules other than the service's own that use it, both sorted. */
export function edgesOf(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Edges {
  const { programs, user } = parsedFiles(files);
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
      if (service !== undefined && user.has(service)) bound.set(variable, service);
    });
    walk(program, (n) => {
      if (n.type !== "MemberExpression" && n.type !== "StaticMemberExpression") return;
      const service = bound.get(identName(n["object"]) ?? "");
      const member = identName(n["property"]);
      const home = service === undefined ? undefined : user.get(service);
      if (service === undefined || member === undefined || home === undefined || home === module || ground.has(home)) return;
      const key = `${service}.${member}`;
      edges.set(key, (edges.get(key) ?? new Set()).add(module));
    });
  }
  return Object.fromEntries([...edges.keys()].toSorted().map((k) => [k, [...(edges.get(k) ?? [])].toSorted()]));
}

/** Service → every non-test module outside its own (HTTP included) that yields it, both sorted. */
export function fanInOf(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): FanIn {
  const { programs, user } = parsedFiles(files);
  const callers = new Map<string, Set<string>>();
  for (const [service, home] of user) if (!ground.has(home)) callers.set(service, new Set());
  for (const { path, program } of programs) {
    const module = moduleOf(path);
    if (module === undefined || skipped.test(path)) continue;
    walk(program, (n) => {
      if (n.type !== "YieldExpression" || n["delegate"] !== true) return;
      const service = identName(n["argument"]);
      const home = service === undefined ? undefined : user.get(service);
      if (service === undefined || home === undefined || home === module || !callers.has(service)) return;
      callers.get(service)?.add(module);
    });
  }
  return Object.fromEntries([...callers.keys()].toSorted().map((k) => [k, [...(callers.get(k) ?? [])].toSorted()]));
}

/** Single-caller top-level Context.Services outside `singleCallerServices`, or stale allowlist entries. */
export function fanInProblems(fanIn: FanIn, allowed: ReadonlySet<string> = singleCallerServices): string[] {
  const problems: string[] = [];
  for (const [service, callers] of Object.entries(fanIn)) {
    if (callers.length <= 1 && !allowed.has(service))
      problems.push(
        `${service} has ${callers.length === 0 ? "no" : `only one (${callers[0]})`} caller module outside its own. ` +
          `Fix: keep single-caller helpers inside the caller's module instead of registering a top-level Context.Service, ` +
          `or list a leaf gateway service in singleCallerServices with its reason. See docs/subsystems/foundation.md`,
      );
    if (callers.length > 1 && allowed.has(service))
      problems.push(
        `${service} now has ${callers.length} caller modules (${callers.join(", ")}). ` +
          `Fix: drop ${service} from singleCallerServices in scripts/service-paths.ts.`,
      );
  }
  for (const service of [...allowed].toSorted())
    if (!(service in fanIn))
      problems.push(
        `${service} is in singleCallerServices but no longer exists. ` + `Fix: drop ${service} from singleCallerServices in scripts/service-paths.ts.`,
      );
  return problems;
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
            `and say why in the PR. See docs/subsystems/foundation.md`,
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
  const sources = paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const now = edgesOf(sources);
  const fanIn = fanInOf(sources);
  // One line a member, as the formatter keeps it.
  if (values.write === true)
    writeFileSync(
      tablePath,
      `{\n${Object.entries(now)
        .map(([key, modules]) => `  ${JSON.stringify(key)}: ${JSON.stringify(modules).replaceAll(",", ", ")}`)
        .join(",\n")}\n}\n`,
    );
  if (values.check === true || values.write === true) {
    const kept: Edges = JSON.parse(readFileSync(tablePath, "utf8"));
    const problems = [...pathProblems(kept, now), ...fanInProblems(fanIn)];
    for (const p of problems) console.error(`paths: ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`paths: ${Object.keys(now).length} service members used across modules, no new path or single-caller service`);
  } else for (const [key, modules] of Object.entries(now)) console.log(`${key.padEnd(40)} ${modules.join(", ")}`);
}
