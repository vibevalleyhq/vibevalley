import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  bumpVersion,
  formatVersion,
  normalizeChannel,
  parseVersion,
  readRootVersion,
  resolveExplicitIncrement,
  scriptArgs,
  writeRootVersion,
} from "./version.ts";

export function applyLocalGitReleaseActions(root: string, version: string, options: { readonly commit: boolean; readonly tag: boolean }): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  if (options.commit) {
    const diff = git("status", "--porcelain", "--", "package.json");
    if (diff === "") {
      console.log("git commit skipped: package.json has no uncommitted changes");
    } else {
      execFileSync("git", ["commit", "--only", "package.json", "-m", `Bump version to ${version}`], {
        cwd: root,
        stdio: "inherit",
      });
    }
  }

  if (options.tag) {
    const tagName = `v${version}`;
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
      cwd: root,
      stdio: "ignore",
    }).status;
    if (exists === 0) {
      throw new Error(`Git tag ${tagName} already exists locally.`);
    }
    execFileSync("git", ["tag", "--annotate", tagName, "--message", `VibeValley ${version}`], {
      cwd: root,
      stdio: "inherit",
    });
    console.log(`Created local tag ${tagName} (not pushed).`);
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const { values, positionals } = parseArgs({
    args: scriptArgs(),
    allowPositionals: true,
    options: {
      patch: { type: "boolean", default: false },
      minor: { type: "boolean", default: false },
      major: { type: "boolean", default: false },
      set: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      commit: { type: "boolean", default: false },
      tag: { type: "boolean", default: false },
    },
  });

  const current = readRootVersion(root) ?? "0.0.0";
  const increment = resolveExplicitIncrement(values) ?? "auto";

  let next: string;
  if (values.set !== undefined) {
    if (increment !== "auto") {
      throw new Error("--set cannot be combined with --patch, --minor, or --major");
    }
    const parsed = parseVersion(values.set);
    if (!parsed) {
      throw new Error(`Invalid --set version "${values.set}". Expected X.Y.Z, X.Y.Z-alpha.N, or X.Y.Z-beta.N.`);
    }
    next = formatVersion(parsed);
  } else {
    const rawChannel = positionals[0];
    if (!rawChannel) {
      throw new Error("Usage: vp run bump -- <alpha|beta|release> [--patch|--minor|--major] [--set <ver>] [--dry-run] [--commit] [--tag]");
    }
    const channel = normalizeChannel(rawChannel);
    if (!channel) {
      throw new Error(`Unknown channel "${rawChannel}". Expected alpha, beta, or release.`);
    }
    next = bumpVersion(current, channel, increment);
  }

  console.log(`${current} -> ${next}`);
  if (values["dry-run"]) {
    if (values.commit) console.log(`[dry-run] would commit package.json: Bump version to ${next}`);
    if (values.tag) console.log(`[dry-run] would create local tag v${next}`);
    process.exit(0);
  }

  writeRootVersion(root, next);
  if (values.commit || values.tag) {
    applyLocalGitReleaseActions(root, next, { commit: values.commit, tag: values.tag });
  }
}
