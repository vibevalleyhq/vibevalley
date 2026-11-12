import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

/** Which server module uses which member of another module's service, read from syntax. The services are what
 * apps/server/src/services.ts builds: a `type X` it imports next to a `makeX`. A name is bound to a service by its
 * type: a parameter, a variable or a property declared as `X` (or `Pick<X, …>`, followed through imports, interfaces,
 * `extends` and intersections), so `deps.agent.list()`, `const { agent: store } = deps; store.list()` and
 * `const { list } = deps.agent` are all uses of Agent.list. Kept in scripts/audit/service-paths.json; a new edge is a
 * new path to that member, and it has to be written down on purpose (docs/subsystems/foundation.md).
 *
 * Not seen: a service whose type is only inferred (no annotation on the way), or one member handed on as a function
 * (`readonly get: Issue["get"]`). Those are missed, never reported wrongly. */

type Node = { readonly type?: unknown; readonly start?: number; readonly [key: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v) && "type" in v && typeof v.type === "string";
const children = (node: Node): Node[] => {
  const out: Node[] = [];
  for (const key in node) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out;
};
const walk = (node: Node, visit: (n: Node) => void) => {
  visit(node);
  for (const c of children(node)) walk(c, visit);
};
const identName = (n: unknown): string | undefined => (isNode(n) && n.type === "Identifier" && typeof n["name"] === "string" ? n["name"] : undefined);
const keyName = (n: unknown): string | undefined =>
  identName(n) ?? (isNode(n) && n.type === "Literal" && typeof n["value"] === "string" ? n["value"] : undefined);

const root = "apps/server/src/";
const servicesFile = `${root}services.ts`;
/** Handlers only forward (AGENTS.md); the ground (infra, base) is everyone's. */
const outerCallers = new Set(["http"]);
const ground = new Set(["infra", "base"]);
/** Tests and what only tests load (flows/farm.ts is the cross-module tests' farm). */
const skipped = /\.(test|spec)\.ts$|\/testing\/|\/testdata\/|^apps\/server\/src\/flows\/|\.d\.ts$/u;
/** Leaf gateway/gamification services reached only by HTTP, Core's late-bound Projection, and Machine (staged for apps/machine). */
export const singleCallerServices = new Set(["Connector", "Game", "Lan", "Machine", "Mcp", "Projection", "Voice"]);
/** Types that keep the members of their first argument. */
const keeping = new Set(["Pick", "Omit", "Readonly", "Partial", "Required", "NonNullable"]);

/** A file's module: the folder under apps/server/src it sits in; undefined for the files at the top (services.ts). */
export const moduleOf = (path: string): string | undefined => {
  const rest = path.startsWith(root) ? path.slice(root.length) : undefined;
  const [first, second, ...more] = rest?.split("/") ?? [];
  if ((first === "modules" || first === "gateway") && second !== undefined) return second;
  return second !== undefined || more.length > 0 ? first : undefined;
};

export type Edges = Readonly<Record<string, readonly string[]>>;
export type FanIn = Readonly<Record<string, readonly string[]>>;
type Source = { readonly path: string; readonly text: string };

/** What a type says about the names bound to it: a service, or a shape whose properties may lead to one. */
type Shape = { readonly service: string } | { readonly props: ReadonlyMap<string, Shape> };
const serviceOf = (s: Shape | undefined) => (s !== undefined && "service" in s ? s.service : undefined);
const propOf = (s: Shape | undefined, key: string) => (s !== undefined && "props" in s ? s.props.get(key) : undefined);

/** The file an import names, when it is one of the server's own; undefined for packages. */
function resolveImport(from: string, source: string): string | undefined {
  if (source.startsWith("#/")) return root + source.slice(2);
  if (source.startsWith(".")) return posix.normalize(posix.join(posix.dirname(from), source));
  return undefined;
}

function program(files: readonly Source[]) {
  const programs = new Map<string, Node>();
  for (const { path, text } of files) {
    const parsed: unknown = parseSync(path, text, { lang: "ts" }).program;
    if (isNode(parsed)) programs.set(path, parsed);
  }
  /** Per file: its own type declarations, and the names it imports (local → [file, exported name]). */
  const declared = new Map<string, Map<string, Node>>();
  const imported = new Map<string, Map<string, readonly [string, string]>>();
  for (const [path, prog] of programs) {
    const own = new Map<string, Node>();
    const names = new Map<string, readonly [string, string]>();
    for (const statement of children(prog).flatMap((n) => (n.type === "Program" ? children(n) : [n]))) {
      const decl = statement.type === "ExportNamedDeclaration" && isNode(statement["declaration"]) ? statement["declaration"] : statement;
      if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") {
        const name = identName(decl["id"]);
        if (name !== undefined) own.set(name, decl);
      }
      if (statement.type === "ImportDeclaration" && isNode(statement["source"])) {
        const target = resolveImport(path, String(statement["source"]["value"]));
        if (target === undefined) continue;
        for (const spec of Array.isArray(statement["specifiers"]) ? statement["specifiers"].filter(isNode) : []) {
          const local = identName(spec["local"]);
          const name = identName(spec["imported"]);
          if (spec.type === "ImportSpecifier" && local !== undefined && name !== undefined) names.set(local, [target, name]);
        }
      }
    }
    declared.set(path, own);
    imported.set(path, names);
  }

  /** The services: `type X` imported by services.ts next to a `makeX`, keyed by the file that declares X. */
  const services = new Map<string, { readonly name: string; readonly home: string }>();
  const atTop = imported.get(servicesFile) ?? new Map<string, readonly [string, string]>();
  const makers = new Map([...atTop].filter(([local]) => /^make[A-Z]/u.test(local)).map(([local, [file]]) => [local.slice(4), file]));
  for (const [local, [file, name]] of atTop) {
    const maker = makers.get(local);
    const home = maker === undefined ? undefined : moduleOf(maker);
    if (home !== undefined) services.set(`${file}#${name}`, { name: local, home });
  }
  const homeOf = new Map([...services.values()].map((s) => [s.name, s.home]));

  /** Where a type name used in a file is declared: [file, name], following imports. */
  const whereIs = (file: string, name: string): readonly [string, string] => {
    if (declared.get(file)?.has(name) === true) return [file, name];
    return imported.get(file)?.get(name) ?? [file, name];
  };

  const memo = new Map<string, Shape | undefined>();
  const shapeOfName = (file: string, name: string): Shape | undefined => {
    const [at, real] = whereIs(file, name);
    const key = `${at}#${real}`;
    const service = services.get(key);
    if (service !== undefined) return { service: service.name };
    if (memo.has(key)) return memo.get(key);
    memo.set(key, undefined);
    const decl = declared.get(at)?.get(real);
    let shape: Shape | undefined;
    if (decl?.type === "TSTypeAliasDeclaration") shape = shapeOfType(at, decl["typeAnnotation"]);
    else if (decl?.type === "TSInterfaceDeclaration") {
      const props = new Map<string, Shape>();
      for (const heritage of Array.isArray(decl["extends"]) ? decl["extends"].filter(isNode) : []) {
        const base = identName(heritage["expression"]);
        const inherited = base === undefined ? undefined : shapeOfName(at, base);
        if (inherited !== undefined && "props" in inherited) for (const [k, v] of inherited.props) props.set(k, v);
      }
      const body = decl["body"];
      for (const [k, v] of membersOf(at, isNode(body) ? body["body"] : undefined)) props.set(k, v);
      shape = props.size > 0 ? { props } : undefined;
    }
    memo.set(key, shape);
    return shape;
  };
  const membersOf = (file: string, members: unknown): Map<string, Shape> => {
    const props = new Map<string, Shape>();
    for (const m of Array.isArray(members) ? members.filter(isNode) : []) {
      const key = m.type === "TSPropertySignature" ? keyName(m["key"]) : undefined;
      const shape = key === undefined ? undefined : shapeOfAnnotation(file, m["typeAnnotation"]);
      if (key !== undefined && shape !== undefined) props.set(key, shape);
    }
    return props;
  };
  const shapeOfType = (file: string, type: unknown): Shape | undefined => {
    if (!isNode(type)) return undefined;
    switch (type.type) {
      case "TSTypeReference": {
        const name = identName(type["typeName"]);
        if (name === undefined) return undefined;
        const args = type["typeArguments"];
        if (keeping.has(name)) return isNode(args) && Array.isArray(args["params"]) ? shapeOfType(file, args["params"][0]) : undefined;
        return shapeOfName(file, name);
      }
      case "TSTypeLiteral": {
        const props = membersOf(file, type["members"]);
        return props.size > 0 ? { props } : undefined;
      }
      case "TSIntersectionType": {
        const props = new Map<string, Shape>();
        for (const part of Array.isArray(type["types"]) ? type["types"] : []) {
          const shape = shapeOfType(file, part);
          if (shape !== undefined && "props" in shape) for (const [k, v] of shape.props) props.set(k, v);
        }
        return props.size > 0 ? { props } : undefined;
      }
      case "TSUnionType": {
        const shapes = (Array.isArray(type["types"]) ? type["types"] : []).filter(
          (t) => !(isNode(t) && (t.type === "TSUndefinedKeyword" || t.type === "TSNullKeyword")),
        );
        return shapes.length === 1 ? shapeOfType(file, shapes[0]) : undefined;
      }
      case "TSParenthesizedType":
        return shapeOfType(file, type["typeAnnotation"]);
      default:
        return undefined;
    }
  };
  const shapeOfAnnotation = (file: string, annotation: unknown) => (isNode(annotation) ? shapeOfType(file, annotation["typeAnnotation"]) : undefined);

  /** Every service member a file uses: walks its scopes, binding names to shapes. */
  const usesIn = (file: string, prog: Node): Set<string> => {
    const uses = new Set<string>();
    const scopes: Map<string, Shape | undefined>[] = [];
    const bound = new Set<Node>();
    const lookup = (name: string) => {
      for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]?.has(name) === true) return scopes[i]?.get(name);
      return undefined;
    };
    const shapeOfExpr = (e: unknown): Shape | undefined => {
      if (!isNode(e)) return undefined;
      if (e.type === "Identifier") return lookup(identName(e) ?? "");
      if ((e.type === "MemberExpression" || e.type === "StaticMemberExpression") && e["computed"] !== true)
        return propOf(shapeOfExpr(e["object"]), identName(e["property"]) ?? "");
      if (e.type === "TSNonNullExpression" || e.type === "ParenthesizedExpression" || e.type === "TSAsExpression") return shapeOfExpr(e["expression"]);
      return undefined;
    };
    const bind = (pattern: unknown, shape: Shape | undefined) => {
      if (!isNode(pattern)) return;
      const own = shapeOfAnnotation(file, pattern["typeAnnotation"]) ?? shape;
      switch (pattern.type) {
        case "Identifier":
          scopes.at(-1)?.set(identName(pattern) ?? "", own);
          return;
        case "AssignmentPattern":
          bind(pattern["left"], own);
          return;
        case "RestElement":
          bind(pattern["argument"], undefined);
          return;
        case "ArrayPattern":
          for (const e of Array.isArray(pattern["elements"]) ? pattern["elements"] : []) bind(e, undefined);
          return;
        case "ObjectPattern": {
          const service = serviceOf(own);
          for (const p of Array.isArray(pattern["properties"]) ? pattern["properties"].filter(isNode) : []) {
            if (p.type !== "Property") {
              bind(p, undefined);
              continue;
            }
            const key = p["computed"] === true ? undefined : keyName(p["key"]);
            if (service !== undefined && key !== undefined) uses.add(`${service}.${key}`);
            bind(p["value"], key === undefined ? undefined : propOf(own, key));
          }
          return;
        }
        default:
          return;
      }
    };
    const declarators = (statement: Node): Node[] => {
      const decl = statement.type === "ExportNamedDeclaration" && isNode(statement["declaration"]) ? statement["declaration"] : statement;
      return decl.type === "VariableDeclaration" && Array.isArray(decl["declarations"]) ? decl["declarations"].filter(isNode) : [];
    };
    const visit = (n: Node) => {
      const fn = n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
      const block = n.type === "Program" || n.type === "BlockStatement" || n.type === "StaticBlock";
      if (fn || block) scopes.push(new Map());
      if (fn)
        for (const p of Array.isArray(n["params"]) ? n["params"] : []) bind(isNode(p) && p.type === "TSParameterProperty" ? p["parameter"] : p, undefined);
      // A block's declarations are bound before its statements run, so a closure above one still sees it.
      if (block)
        for (const d of (Array.isArray(n["body"]) ? n["body"].filter(isNode) : []).flatMap(declarators)) {
          bound.add(d);
          bind(d["id"], shapeOfExpr(d["init"]));
        }
      if (n.type === "VariableDeclarator" && !bound.has(n)) bind(n["id"], shapeOfExpr(n["init"]));
      if ((n.type === "MemberExpression" || n.type === "StaticMemberExpression") && n["computed"] !== true) {
        const service = serviceOf(shapeOfExpr(n["object"]));
        const member = identName(n["property"]);
        if (service !== undefined && member !== undefined) uses.add(`${service}.${member}`);
      }
      for (const c of children(n)) if (c.type !== "TSTypeAnnotation") visit(c);
      if (fn || block) scopes.pop();
    };
    visit(prog);
    return uses;
  };

  /** Every service a file names as a type, whatever for. */
  const namedIn = (file: string, prog: Node): Set<string> => {
    const named = new Set<string>();
    walk(prog, (n) => {
      if (n.type !== "TSTypeReference") return;
      const name = identName(n["typeName"]);
      const [at, real] = name === undefined ? ["", ""] : whereIs(file, name);
      const service = services.get(`${at}#${real}`);
      if (service !== undefined) named.add(service.name);
    });
    return named;
  };

  return { programs, homeOf, usesIn, namedIn };
}

/** Service.member → the modules other than the service's own that use it, both sorted. */
export function edgesOf(files: readonly Source[]): Edges {
  const { programs, homeOf, usesIn } = program(files);
  const edges = new Map<string, Set<string>>();
  for (const [path, prog] of programs) {
    const module = moduleOf(path);
    if (module === undefined || outerCallers.has(module) || skipped.test(path)) continue;
    for (const key of usesIn(path, prog)) {
      const home = homeOf.get(key.split(".")[0] ?? "");
      if (home === undefined || home === module || ground.has(home)) continue;
      edges.set(key, (edges.get(key) ?? new Set()).add(module));
    }
  }
  return Object.fromEntries([...edges.keys()].toSorted().map((k) => [k, [...(edges.get(k) ?? [])].toSorted()]));
}

/** Service → every non-test module outside its own (HTTP included) that names it as a type, both sorted. */
export function fanInOf(files: readonly Source[]): FanIn {
  const { programs, homeOf, namedIn } = program(files);
  const callers = new Map<string, Set<string>>();
  for (const [service, home] of homeOf) if (!ground.has(home)) callers.set(service, new Set());
  for (const [path, prog] of programs) {
    const module = moduleOf(path);
    if (module === undefined || skipped.test(path)) continue;
    for (const service of namedIn(path, prog)) if (homeOf.get(service) !== module) callers.get(service)?.add(module);
  }
  return Object.fromEntries([...callers.keys()].toSorted().map((k) => [k, [...(callers.get(k) ?? [])].toSorted()]));
}

/** Single-caller top-level services outside `singleCallerServices`, or stale allowlist entries. */
export function fanInProblems(fanIn: FanIn, allowed: ReadonlySet<string> = singleCallerServices): string[] {
  const problems: string[] = [];
  for (const [service, callers] of Object.entries(fanIn)) {
    if (callers.length <= 1 && !allowed.has(service))
      problems.push(
        `${service} has ${callers.length === 0 ? "no" : `only one (${callers[0]})`} caller module outside its own. ` +
          `Fix: keep single-caller helpers inside the caller's module instead of building a top-level service in services.ts, ` +
          `or list a leaf gateway service in singleCallerServices with its reason. See docs/subsystems/foundation.md`,
      );
    if (callers.length > 1 && allowed.has(service))
      problems.push(
        `${service} now has ${callers.length} caller modules (${callers.join(", ")}). ` +
          `Fix: drop ${service} from singleCallerServices in scripts/audit/service-paths.ts.`,
      );
  }
  for (const service of [...allowed].toSorted())
    if (!(service in fanIn))
      problems.push(
        `${service} is in singleCallerServices but no longer exists. ` + `Fix: drop ${service} from singleCallerServices in scripts/audit/service-paths.ts.`,
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

export const tablePath = "scripts/audit/service-paths.json";

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: "boolean" }, write: { type: "boolean" } } });
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", root], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p.endsWith(".ts") && existsSync(p));
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
