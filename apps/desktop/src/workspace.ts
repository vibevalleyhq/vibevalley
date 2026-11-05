import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

const manifest = (dir: string) => Schema.decodeUnknownSync(Manifest)(readFileSync(join(dir, "package.json"), "utf8"));

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
