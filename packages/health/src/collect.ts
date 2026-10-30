/**
 * What the readings are taken from: git's history and the tracked source at HEAD. "Now" is HEAD's commit time, so the
 * same commit reads the same on every machine and on every run.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RawCommit, Source } from "./readings.ts";

const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export const headTime = (root: string) => Number(git(root, ["log", "-1", "--format=%ct"]).trim()) * 1000;

/** The first commit's time: a window that starts before it has no history to compare with. */
export const firstTime = (root: string) => Number(git(root, ["log", "--max-parents=0", "--format=%ct"]).trim().split("\n").at(-1)) * 1000;

/** The tracked .ts and .tsx files as they are on disk. */
export function sources(root: string): Source[] {
  return git(root, ["ls-files", "-z", "--", "*.ts", "*.tsx"])
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** The commits since `since` (ms), newest first, renames followed. */
export function commits(root: string, since: number): RawCommit[] {
  const out = git(root, ["log", "-M", "--name-status", `--since=@${Math.floor(since / 1000)}`, "--format=%x1e%H%x1f%ct"]);
  return out
    .split("\x1e")
    .filter((r) => r.trim())
    .map((record) => {
      const [head = "", ...lines] = record.split("\n");
      const [sha = "", at = "0"] = head.split("\x1f");
      const entries = lines.flatMap((line) => {
        const [status = "", a, b] = line.split("\t");
        if (!a) return [];
        return status.startsWith("R") && b ? [{ path: b, from: a }] : [{ path: a }];
      });
      return { sha, at: Number(at) * 1000, entries };
    });
}
