import { t } from "@vibevalley/i18n";
// What a project is built with, from the markers at its root, first one wins.

import type { ProjectStack } from "@vibevalley/protocol";
import { Option, Schema } from "effect";

const empty: ProjectStack = { name: "", label: "" };

/** Commands the project has none of are left out, as the Go leaves out an empty one. */
const withCommands = ({ test, lint, build, ...s }: ProjectStack): ProjectStack => ({
  ...s,
  ...(test ? { test } : {}),
  ...(lint ? { lint } : {}),
  ...(build ? { build } : {}),
});

export const stackFiles = [
  "go.mod",
  "Cargo.toml",
  "pubspec.yaml",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/** files: the ones of stackFiles that are there, by name, with what they say. */
export function stackOf(files: ReadonlyMap<string, string>): ProjectStack {
  const read = (name: (typeof stackFiles)[number]) => files.get(name);
  const has = (name: (typeof stackFiles)[number]) => files.has(name);
  const stack = (s: Partial<ProjectStack>) => withCommands({ ...empty, ...s });
  if (has("go.mod"))
    return stack({
      name: "go",
      label: "Go",
      test: "go test ./...",
      lint: "go vet ./...",
      build: "go build ./...",
    });
  if (has("Cargo.toml"))
    return stack({
      name: "rust",
      label: "Rust",
      test: "cargo test",
      lint: "cargo clippy",
      build: "cargo build",
    });
  const pubspec = read("pubspec.yaml");
  if (pubspec !== undefined)
    return pubspec.includes("flutter")
      ? stack({ name: "flutter", label: "Flutter", test: "flutter test", lint: "flutter analyze" })
      : stack({ name: "dart", label: "Dart", test: "dart test", lint: "dart analyze" });
  const pkg = read("package.json");
  if (pkg !== undefined) return nodeStack(pkg, has);
  const pyproject = read("pyproject.toml");
  if (pyproject !== undefined || has("requirements.txt") || has("setup.py"))
    return stack({
      name: "python",
      label: "Python",
      test: "pytest",
      lint: pyproject?.includes("ruff") ? "ruff check ." : "",
    });
  return empty;
}

// An unreadable package.json, or one whose scripts are not all text, has none.
const scriptsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })),
);

/** The package orchestrator is the lockfile's; a command is there only when package.json has that script, always as `<pm> run <script>`. */
function nodeStack(pkg: string, has: (name: (typeof stackFiles)[number]) => boolean): ProjectStack {
  const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const scripts: Readonly<Record<string, string>> = Option.match(scriptsOf(pkg), { onNone: () => ({}), onSome: (p) => p.scripts ?? {} });
  const runScript = (s: string) => (scripts[s]?.trim() ? `${pm} run ${s}` : "");
  return withCommands({
    name: "node",
    label: t("shared.join.aside", { text: "Node", aside: pm }),
    test: runScript("test"),
    lint: runScript("lint"),
    build: runScript("build"),
  });
}
