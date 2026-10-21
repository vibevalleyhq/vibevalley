// What a project is built with, from the markers at its root, first one wins.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectStack } from "@vibevalley/protocol";

const empty: ProjectStack = { name: "", label: "" };

/** Commands the project has none of are left out, as the Go leaves out an empty one. */
const withCommands = (s: ProjectStack): ProjectStack =>
  Object.fromEntries(Object.entries(s).filter(([k, v]) => v !== "" || k === "name" || k === "label")) as ProjectStack;

export function stackOf(dir: string): ProjectStack {
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const has = (name: string) => read(name) !== undefined;
  const stack = (s: Partial<ProjectStack>) => withCommands({ ...empty, ...s });
  if (has("go.mod")) return stack({ name: "go", label: "Go", test: "go test ./...", lint: "go vet ./...", build: "go build ./..." });
  if (has("Cargo.toml")) return stack({ name: "rust", label: "Rust", test: "cargo test", lint: "cargo clippy", build: "cargo build" });
  const pubspec = read("pubspec.yaml");
  if (pubspec !== undefined)
    return pubspec.includes("flutter")
      ? stack({ name: "flutter", label: "Flutter", test: "flutter test", lint: "flutter analyze" })
      : stack({ name: "dart", label: "Dart", test: "dart test", lint: "dart analyze" });
  const pkg = read("package.json");
  if (pkg !== undefined) return nodeStack(pkg, has);
  const pyproject = read("pyproject.toml");
  if (pyproject !== undefined || has("requirements.txt") || has("setup.py"))
    return stack({ name: "python", label: "Python", test: "pytest", lint: pyproject?.includes("ruff") ? "ruff check ." : "" });
  return empty;
}

/** The package manager is the lockfile's; a command is there only when package.json has that script, always as `<pm> run <script>`. */
function nodeStack(pkg: string, has: (name: string) => boolean): ProjectStack {
  const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // An unreadable package.json has no scripts.
  }
  const runScript = (s: string) => (scripts[s]?.trim() ? `${pm} run ${s}` : "");
  return withCommands({ name: "node", label: `Node（${pm}）`, test: runScript("test"), lint: runScript("lint"), build: runScript("build") });
}
