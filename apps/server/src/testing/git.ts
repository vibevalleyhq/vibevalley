// Real git repositories for tests.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@vibevalley/testkit/temp";

/** Runs git in dir as a test user; its output, trimmed. A failure throws with what git said. */
export const gitSync = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@vibevalley.test", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Runs git in dir as dir's own config says (no test user); its output, trimmed. A failure throws with what git said. */
export const gitIn = (dir: string, ...args: string[]) => gitInEnv(dir, {}, ...args);

/** gitIn with these in its environment (a commit's dates). */
export const gitInEnv = (dir: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A projects folder of its own, under a work root of its own. */
export function projectsDir(): string {
  const root = join(tempDir("vibevalley-work-"), "projects");
  mkdirSync(root);
  return root;
}

/** Each kind of repository made once in this process and copied after: a git command is a process (about 20 ms), and
 * most tests want the same one-commit repository. A copy has the same commits, ids included; nothing compares them. */
const templates = new Map<string, string>();

/** A repository with `mine` commits by the test user, `others` by someone else. */
export function repo(dir: string, mine: number, others: number) {
  const key = `${mine}:${others}`;
  let template = templates.get(key);
  if (template === undefined) {
    template = join(tempDir("vibevalley-repo-"), "repo");
    made(template, mine, others);
    templates.set(key, template);
  }
  cpSync(template, dir, { recursive: true });
}

function made(dir: string, mine: number, others: number) {
  mkdirSync(dir, { recursive: true });
  gitSync(dir, "init", "-q", "-b", "main");
  gitSync(dir, "config", "user.email", "test@vibevalley.test");
  // No maintenance in the background after a commit: it takes .git/objects/maintenance.lock in the template while it is
  // being copied, and a copy (which inherits this config) would race the test's own git the same way.
  gitSync(dir, "config", "maintenance.auto", "false");
  gitSync(dir, "config", "gc.auto", "0");
  for (let i = 0; i < mine; i++) gitSync(dir, "commit", "-q", "--allow-empty", "-m", `mine ${i}`);
  for (let i = 0; i < others; i++)
    execFileSync("git", ["-c", "user.name=other", "-c", "user.email=other@x", "commit", "-q", "--allow-empty", "-m", `other ${i}`], { cwd: dir });
}

export const write = (path: string, body: string, mode = 0o644) => writeFileSync(path, body, { mode });
