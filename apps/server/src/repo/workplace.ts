import { Option, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type { RepoStack, PullRequest } from "@vibevalley/protocol";

export interface Workplace {
  readonly repo: string;
  readonly cwd: string;
  /** Empty when it works in the repo folder itself. */
  readonly branch?: string;
}

/** A retained branch or worktree still belongs to its issue, even after a failed dispatch. */
export type WorkplaceRelease = { readonly kept: false } | { readonly kept: true; readonly reason: string };
export type WorkplaceCleanup = "discard" | "preserve";

export interface RepoFolder {
  readonly name: string;
  readonly path: string;
  readonly git: boolean;
}

export interface Merged {
  readonly pullRequest?: PullRequest;
  readonly text: string;
  readonly commits: number;
  readonly hashes?: readonly string[];
  /** Publication succeeded; these resources could not be removed. */
  readonly warning?: string;
}

const MergeFailureKindValues = ["conflict", "check", "error"] as const;

/** Why a merge did not go in: a conflict (and with what), the check, or git. */
/** Work that did not merge: a conflict (with the base and its files), a failed check, or anything else. */
export class MergeFailure extends Schema.TaggedError<MergeFailure, { readonly brand: unique symbol }>()("MergeFailure", {
  kind: Schema.Literals(MergeFailureKindValues),
  reasonText: Schema.String,
  base: Schema.String,
  files: Schema.Array(Schema.String),
  message: Schema.String,
}) {
  static conflict(base: string, files: readonly string[]) {
    return new MergeFailure({
      kind: "conflict",
      reasonText: "",
      base,
      files,
      message: t("server.repo.conflict", { base }),
    });
  }
  static failedCheck(why: string) {
    return new MergeFailure({ kind: "check", reasonText: why, base: "", files: [], message: why });
  }
  static error(why: string) {
    return new MergeFailure({ kind: "error", reasonText: why, base: "", files: [], message: why });
  }
}

export class RepoError extends Schema.TaggedError<RepoError, { readonly brand: unique symbol }>()("RepoError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Where, in a worktree's git directory (git rev-parse --git-path), its helper leaves the pull request's title and body. */
export const pullRequestFile = "vibevalley-pr.md";

/** The title and body a helper wrote: the first line (a leading # dropped) and what follows it; undefined when it gave
 * no title. */
export function pullRequestText(text: string): { readonly title: string; readonly body: string } | undefined {
  const [first = "", ...rest] = text.replace(/\r\n/gu, "\n").trim().split("\n");
  const title = first.replace(/^#+\s*/u, "").trim();
  return title === "" ? undefined : { title, body: rest.join("\n").trim() };
}

// What a repo is built with, from the markers at its root, first one wins.

const emptyStack: RepoStack = { name: "", label: "" };

const withCommands = ({ test, lint, build, ...s }: RepoStack): RepoStack => ({
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
  "pyrepo.toml",
  "requirements.txt",
  "setup.py",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/** files: the ones of stackFiles that are there, by name, with what they say. */
export function stackOf(files: ReadonlyMap<string, string>): RepoStack {
  const read = (name: (typeof stackFiles)[number]) => files.get(name);
  const has = (name: (typeof stackFiles)[number]) => files.has(name);
  const stack = (s: Partial<RepoStack>) => withCommands({ ...emptyStack, ...s });
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
  const pyrepo = read("pyrepo.toml");
  if (pyrepo !== undefined || has("requirements.txt") || has("setup.py"))
    return stack({
      name: "python",
      label: "Python",
      test: "pytest",
      lint: pyrepo?.includes("ruff") === true ? "ruff check ." : "",
    });
  return emptyStack;
}

// An unreadable package.json, or one whose scripts are not all text, has none.
const scriptsOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })),
);

/** The package orchestrator is the lockfile's; a command is there only when package.json has that script, always as `<pm> run <script>`. */
function nodeStack(pkg: string, has: (name: (typeof stackFiles)[number]) => boolean): RepoStack {
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
