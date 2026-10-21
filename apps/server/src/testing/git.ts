// Real git repositories for tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git in dir as a test user; its output, trimmed. A failure throws with what git said. */
export const gitSync = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@vibevalley.test", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A projects folder of its own, under a work root of its own. */
export function projectsDir(): string {
  const root = join(mkdtempSync(join(tmpdir(), "vibevalley-work-")), "projects");
  mkdirSync(root);
  return root;
}

/** A repository with `mine` commits by the test user, `others` by someone else. */
export function repo(dir: string, mine: number, others: number) {
  mkdirSync(dir, { recursive: true });
  gitSync(dir, "init", "-q", "-b", "main");
  gitSync(dir, "config", "user.email", "test@vibevalley.test");
  for (let i = 0; i < mine; i++) gitSync(dir, "commit", "-q", "--allow-empty", "-m", `mine ${i}`);
  for (let i = 0; i < others; i++)
    execFileSync("git", ["-c", "user.name=other", "-c", "user.email=other@x", "commit", "-q", "--allow-empty", "-m", `other ${i}`], { cwd: dir });
}

export const write = (path: string, body: string, mode = 0o644) => writeFileSync(path, body, { mode });
