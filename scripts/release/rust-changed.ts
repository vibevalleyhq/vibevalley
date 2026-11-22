import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { z } from "zod";

const CargoDependencySchema = z.object({
  name: z.string(),
});

const CargoPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  manifest_path: z.string(),
  dependencies: z.array(CargoDependencySchema),
});

const CargoMetadataSchema = z.object({
  packages: z.array(CargoPackageSchema),
  workspace_members: z.array(z.string()),
  workspace_root: z.string().optional(),
});

export type CargoMetadata = z.infer<typeof CargoMetadataSchema>;

export interface ChangedPackagesResult {
  readonly all: boolean;
  readonly packages: readonly string[];
}

export interface RustChangedOptions {
  readonly base: string;
  readonly dryRun: boolean;
  readonly help: boolean;
}

const ROOT_TRIGGER_FILES = new Set(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".config/nextest.toml"]);

// Nested non-Rust subtrees inside a crate directory: `apps/mac/ui/` is built and checked by `mac:check`,
// and debug builds load it from disk (`apps/mac/build.rs`), so TSX edits do not affect Rust crates.
const NON_RUST_SUBTREES: readonly string[] = ["apps/mac/ui/"];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function normalizeRelativeFile(path: string): string {
  const cleaned = normalizePath(path.trim());
  return cleaned.startsWith("./") ? cleaned.slice(2) : cleaned;
}

function manifestDirRelative(manifestPath: string, baseRoot: string): string | undefined {
  const root = normalizePath(baseRoot);
  const dir = normalizePath(manifestPath).replace(/\/Cargo\.toml$/u, "");
  if (dir === root) return "";
  const prefix = `${root}/`;
  if (dir.startsWith(prefix)) return dir.slice(prefix.length);
  return undefined;
}

function isUnderNonRustSubtree(file: string): boolean {
  return NON_RUST_SUBTREES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
}

/**
 * Maps repository-relative changed files to affected Cargo workspace packages,
 * expanding transitively along the reverse dependency graph.
 */
export function parseChangedPackages(metadata: CargoMetadata, changedFiles: readonly string[], baseRoot: string): ChangedPackagesResult {
  const memberIds = new Set(metadata.workspace_members);
  const members = memberIds.size > 0 ? metadata.packages.filter((pkg) => memberIds.has(pkg.id)) : metadata.packages;
  const allPackages = members.map((pkg) => pkg.name).toSorted();

  const normalizedFiles: string[] = [];
  for (const raw of changedFiles) {
    const file = normalizeRelativeFile(raw);
    if (!file) continue;
    if (ROOT_TRIGGER_FILES.has(file)) {
      return { all: true, packages: allPackages };
    }
    if (!isUnderNonRustSubtree(file)) {
      normalizedFiles.push(file);
    }
  }

  // Sort longest relative directory first so nested crates (e.g. `apps/mac/crates/pixel`)
  // win over enclosing crates (e.g. `apps/mac`).
  const dirs = members
    .flatMap((pkg) => {
      const dir = manifestDirRelative(pkg.manifest_path, baseRoot);
      return dir === undefined ? [] : [{ name: pkg.name, dir }];
    })
    .toSorted((a, b) => {
      const diff = b.dir.length - a.dir.length;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

  const direct = new Set<string>();
  for (const file of normalizedFiles) {
    for (const entry of dirs) {
      if (entry.dir === "") {
        if (file.startsWith("src/") || file.startsWith("tests/") || file.startsWith("benches/") || file.startsWith("examples/") || file === "build.rs") {
          direct.add(entry.name);
          break;
        }
        continue;
      }
      if (file === entry.dir || file.startsWith(`${entry.dir}/`)) {
        direct.add(entry.name);
        break;
      }
    }
  }

  if (direct.size === 0) {
    return { all: false, packages: [] };
  }

  const workspaceNames = new Set(allPackages);
  const dependents = new Map<string, Set<string>>();
  for (const pkg of members) {
    for (const dep of pkg.dependencies) {
      if (!workspaceNames.has(dep.name) || dep.name === pkg.name) continue;
      let set = dependents.get(dep.name);
      if (!set) {
        set = new Set();
        dependents.set(dep.name, set);
      }
      set.add(pkg.name);
    }
  }

  const affected = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const rev = dependents.get(current);
    if (!rev) continue;
    for (const next of rev) {
      if (!affected.has(next)) {
        affected.add(next);
        queue.push(next);
      }
    }
  }

  return { all: false, packages: [...affected].toSorted() };
}

export function parseArgs(argv: readonly string[]): RustChangedOptions {
  let base = "origin/main";
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error("rust:changed: --base requires a git ref");
      base = value;
    } else if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (!value) throw new Error("rust:changed: --base requires a git ref");
      base = value;
    } else {
      throw new Error(`rust:changed: unknown option ${arg}`);
    }
  }
  return { base, dryRun, help };
}

function runCapture(cmd: string, args: readonly string[], cwd: string): string {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${String(res.status)})${detail ? `: ${detail}` : ""}`);
  }
  return res.stdout;
}

function collectChangedFiles(root: string, base: string): string[] {
  const files = new Set<string>();
  const addLines = (out: string) => {
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  };
  addLines(runCapture("git", ["diff", "--name-only", `${base}...HEAD`], root));
  addLines(runCapture("git", ["diff", "--name-only"], root));
  addLines(runCapture("git", ["diff", "--name-only", "--cached"], root));
  addLines(runCapture("git", ["ls-files", "--others", "--exclude-standard"], root));
  return [...files];
}

function runStep(cmd: string, args: readonly string[], cwd: string): number {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

function hasNextest(): boolean {
  const res = spawnSync("cargo", ["nextest", "--version"], { stdio: "ignore" });
  return res.error === undefined && res.status === 0;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: vpx scripts/release/rust-changed.ts [--base <ref>] [--dry-run]");
    return 0;
  }

  const root = resolve(import.meta.dirname, "../..");
  const changedFiles = collectChangedFiles(root, options.base);
  const rawMetadata = runCapture("cargo", ["metadata", "--no-deps", "--format-version", "1"], root);
  const metadata = CargoMetadataSchema.parse(JSON.parse(rawMetadata));
  const { all, packages } = parseChangedPackages(metadata, changedFiles, metadata.workspace_root ?? root);

  if (packages.length === 0) {
    console.log("rust:changed: no affected Rust crates");
    return 0;
  }

  const pkgArgs = packages.flatMap((name) => ["-p", name]);
  if (options.dryRun) {
    console.log(`rust:changed (${all ? "all" : `${packages.length} crates`}): ${pkgArgs.join(" ")}`);
    return 0;
  }

  console.log(`rust:changed: checking ${all ? "all workspace crates" : `${packages.length} crates`} (${packages.join(", ")})`);

  const fmtCode = runStep("cargo", ["fmt", "--all", "--check"], root);
  if (fmtCode !== 0) return fmtCode;

  const clippyCode = runStep("cargo", ["clippy", ...pkgArgs, "--all-targets", "--", "-D", "warnings"], root);
  if (clippyCode !== 0) return clippyCode;

  if (hasNextest()) {
    return runStep("cargo", ["nextest", "run", ...pkgArgs, "--no-fail-fast"], root);
  }
  return runStep("cargo", ["test", ...pkgArgs], root);
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
