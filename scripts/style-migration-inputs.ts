import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export const migrationRoot = resolve(import.meta.dirname, "..");
export const migrationOutput = resolve(migrationRoot, ".test/style-migration");
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface MigrationInput {
  path: string;
  hash: string | null;
}
export interface MigrationInputs {
  revision: string;
  digest: string;
  lockfileHash: string;
  files: MigrationInput[];
  tools: Record<string, string>;
}

function version(name: string, manifest: string): string {
  const require = createRequire(resolve(migrationRoot, manifest));
  let directory = dirname(require.resolve(name));
  while (directory !== dirname(directory)) {
    const file = resolve(directory, "package.json");
    if (existsSync(file)) {
      const input: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof input === "object" && input !== null && "name" in input && input.name === name && "version" in input && typeof input.version === "string")
        return input.version;
    }
    directory = dirname(directory);
  }
  throw new Error(`Missing installed tool version: ${name}`);
}

export function sourceInputs(root: string) {
  const paths = [
    ...new Set(
      execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean),
    ),
  ].toSorted();
  if (paths.length === 0) throw new Error("Empty maintained-file enumeration");
  const files = paths.map((path) => {
    const file = resolve(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() === true) {
      const link = readlinkSync(file);
      return { path, link, hash: existsSync(file) && statSync(file).isFile() ? hash(readFileSync(file)) : hash(`symlink:${link}`) };
    }
    return { path, hash: stat?.isFile() === true ? hash(readFileSync(file)) : null };
  });
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    digest: hash(JSON.stringify(files)),
    lockfileHash: hash(readFileSync(resolve(root, "pnpm-lock.yaml"))),
    files,
  };
}

export function migrationInputs(): MigrationInputs {
  return {
    ...sourceInputs(migrationRoot),
    tools: {
      node: process.version,
      vite: version("vite-plus", "package.json"),
      solid: version("solid-js", "apps/site/package.json"),
      stylex: version("@stylexjs/stylex", "apps/site/package.json"),
      stylexCompiler: version("@stylexjs/unplugin", "apps/site/package.json"),
    },
  };
}
