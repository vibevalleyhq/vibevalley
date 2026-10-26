// The server's layers of the test pyramid (docs/subsystems/foundation.md): a test file's layer is what it reaches through
// everything it imports, type-only imports aside. Under src/flows it is a flow; one whose imports reach a database, a
// child process or the network is a module test; one that stays in the process is a rule test. The budgets, the shape
// printed after a run and the boundaries checked in pyramid.test.ts all ask this one function.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export type Layer = "rule" | "module" | "flow";

export const layers: readonly Layer[] = ["rule", "module", "flow"];

/** What a test of each layer may take, in ms. */
export const budgetMs: Record<Layer, number> = { rule: 20, module: 300, flow: 2_000 };

/** Imports that leave the process: the database, child processes, the network. */
const outside = /^(node:child_process|node:net|node:http|node:https|@electric-sql\/pglite|@effect\/sql-pglite|@effect\/platform-node)$/;

/** What a file imports for its values: import and export … from, side-effect and dynamic imports, not type-only ones. */
export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?"([^"]+)"/gms)) if (!m[1]) out.push(m[2]!);
  for (const m of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push(m[1]!);
  return out;
}

/** The layers of the files under root (apps/server); paths are relative to it, as src/x/y.test.ts. */
export function pyramid(root: string) {
  const sources = new Map<string, string[]>();
  const importsAt = (file: string) => {
    let got = sources.get(file);
    if (!got) {
      const at = join(root, file);
      got = existsSync(at) ? importsOf(readFileSync(at, "utf8")) : [];
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
      if (!spec.startsWith(".")) continue;
      const next = normalize(relative(root, join(root, dirname(file), spec)))
        .split("\\")
        .join("/");
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
