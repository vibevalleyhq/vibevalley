// The workspace packages the server runs on: the ones apps/server/package.json lists as workspace:*, and theirs in
// turn. The packaged app copies them beside the server (scripts/package.ts); in development a change in one restarts it
// (dev.ts). Read from the package.json files, so a package added later is in both without a list to keep.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
}

const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

/** name → folder under packages/. */
function workspacePackages(repo: string): Map<string, string> {
  const root = join(repo, "packages");
  // A folder without a package.json (a package removed, its node_modules left behind) is none.
  const dirs = readdirSync(root).filter((d) => existsSync(join(root, d, "package.json")));
  return new Map(dirs.map((d) => [manifest(join(root, d)).name, join(root, d)]));
}

/** The workspace packages a folder depends on, directly or through another, each once, by name. */
export function workspaceClosure(repo: string, from: string): Map<string, string> {
  const known = workspacePackages(repo);
  const out = new Map<string, string>();
  const visit = (dir: string) => {
    for (const [name, spec] of Object.entries(manifest(dir).dependencies ?? {})) {
      if (!spec.startsWith("workspace:") || out.has(name)) continue;
      const at = known.get(name);
      if (at === undefined) throw new Error(`${name} is not a package under packages/`);
      out.set(name, at);
      visit(at);
    }
  };
  visit(from);
  return out;
}
