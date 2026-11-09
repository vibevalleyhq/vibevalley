import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { Result, Schema } from "effect";

import { importsOf } from "./source.ts";

export type Layer = "rule" | "module" | "flow";

export const layers: readonly Layer[] = ["rule", "module", "flow"];

/** What a test of each layer may take, in ms. */
export const budgetMs: Record<Layer, number> = { rule: 20, module: 300, flow: 2_000 };

/** Imports that leave the process: the database, child processes, the network. */
const outside = /^(node:child_process|node:net|node:http|node:https|node:sqlite|@effect\/sql-sqlite-node|@effect\/platform-node)$/u;

interface SpacePackage {
  readonly dir: string;
  readonly exports: Readonly<Record<string, string>>;
}

/** An export's target: a file, or by condition its built types and its source. */
type Target = string | { readonly types?: string; readonly default?: string };

const Target = Schema.Union([Schema.String, Schema.Struct({ types: Schema.optionalKey(Schema.String), default: Schema.optionalKey(Schema.String) })]);
const Manifest = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, exports: Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Target)])) }),
);

/** The source file an export leads to: what runs is the source (default); only types are built. */
const sourceOf = (t: Target): string => (typeof t === "string" ? t : (t.default ?? ""));

/** The packages under the workspace's packages/ folder, by name; none when root is not inside a workspace. */
function workspacePackages(root: string): Map<string, SpacePackage> {
  let at = root;
  while (!existsSync(join(at, "pnpm-workspace.yaml"))) {
    const up = dirname(at);
    if (up === at) return new Map();
    at = up;
  }
  const out = new Map<string, SpacePackage>();
  for (const d of readdirSync(join(at, "packages"))) {
    const manifest = join(at, "packages", d, "package.json");
    if (!existsSync(manifest)) continue;
    const m = Result.getOrThrow(Schema.decodeResult(Manifest)(readFileSync(manifest, "utf8")));
    const exports = typeof m.exports === "string" ? { ".": m.exports } : (m.exports ?? {});
    out.set(m.name, { dir: join(at, "packages", d), exports: Object.fromEntries(Object.entries(exports).map(([k, v]) => [k, sourceOf(v)])) });
  }
  return out;
}

/** The file an export of a package names: an exact key, or a pattern with one *. */
function exported(exports: Readonly<Record<string, string>>, sub: string): string | undefined {
  if (exports[sub]) return exports[sub];
  for (const [key, target] of Object.entries(exports)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const [pre, post] = [key.slice(0, star), key.slice(star + 1)];
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= key.length - 1) return target.replace("*", sub.slice(pre.length, sub.length - post.length));
  }
  return undefined;
}

/** The layers of the files under root (a package's folder). */
export function pyramid(root: string) {
  const packages = workspacePackages(root);
  /** Where an import of a workspace package leads, relative to root; undefined for anything else. */
  const inSpace = (spec: string): string | undefined => {
    const [scope, name, ...rest] = spec.split("/");
    const pkg = packages.get(`${scope}/${name}`);
    const target = pkg && exported(pkg.exports, rest.length > 0 ? `./${rest.join("/")}` : ".");
    return pkg && target ? relative(root, join(pkg.dir, target)) : undefined;
  };
  const sources = new Map<string, string[]>();
  const importsAt = (file: string) => {
    let got = sources.get(file);
    if (!got) {
      const at = join(root, file);
      got = existsSync(at) ? importsOf(at, readFileSync(at, "utf8")) : [];
      sources.set(file, got);
    }
    return got;
  };
  const reached = new Map<string, readonly string[] | undefined>();
  /** The chain of imports from file to the first thing outside the process; undefined when it stays in. */
  const reach = (file: string, seen: ReadonlySet<string> = new Set()): readonly string[] | undefined => {
    if (reached.has(file)) return reached.get(file);
    if (seen.has(file)) return undefined;
    const inner = new Set(seen).add(file);
    let found: readonly string[] | undefined;
    for (const spec of importsAt(file)) {
      if (outside.test(spec)) {
        found = [file, spec];
        break;
      }
      const target = spec.startsWith(".")
        ? relative(root, join(root, dirname(file), spec))
        : spec.startsWith("@vibevalley/")
          ? inSpace(spec)
          : // An app's #/ is its own src/ and #db/ the server's generated queries (their package.json imports); the
            // workspace packages do not use them.
            spec.startsWith("#/") && !file.startsWith("..")
            ? join("src", spec.slice(2))
            : spec.startsWith("#db/") && !file.startsWith("..")
              ? join("db", "generated", spec.slice(4))
              : undefined;
      if (target === undefined) continue;
      const next = normalize(target).split("\\").join("/");
      const chain = reach(next, inner);
      if (chain) {
        found = [file, ...chain];
        break;
      }
    }
    // A file still being walked further up the chain is not settled yet: only what was walked whole is kept.
    if (found || seen.size === 0) reached.set(file, found);
    return found;
  };
  return {
    reach,
    layerOf: (file: string): Layer => (file.startsWith("src/flows/") ? "flow" : reach(file) ? "module" : "rule"),
  };
}
