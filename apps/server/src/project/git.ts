// Running git and other tools: the output, the exit code and stderr; a tool
// that is not there is code -1.

import { spawn } from "node:child_process";

import { Effect, Schema } from "effect";

import { messageOf } from "@/errors.ts";
import { afterRealTime } from "@/infra/time.ts";

export interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  /** 0 when it went through; -1 when it could not run at all. */
  readonly code: number;
  /** The tool was not found. */
  readonly missing: boolean;
  /** Killed when its time ran out. */
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * Runs a command to its end. It runs in a process group of its own, and a timeout kills the whole group: a check's test
 * runner started by its shell does not outlive it, nor hold its output open.
 */
export const run = (command: string, args: readonly string[], options: RunOptions = {}): Effect.Effect<Ran> =>
  Effect.callback<Ran>((resume) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const killGroup = () => {
      try {
        if (child.pid != null && child.pid !== 0) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    let timedOut = false;
    const cancelTimer =
      options.timeoutMs != null && options.timeoutMs > 0
        ? afterRealTime(options.timeoutMs, () => {
            timedOut = true;
            killGroup();
          })
        : undefined;
    let done = false;
    const finish = (r: Ran) => {
      if (done) return;
      done = true;
      cancelTimer?.();
      resume(Effect.succeed(r));
    };
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish({
        stdout: "",
        stderr: e.message,
        code: -1,
        missing: e.code === "ENOENT",
        timedOut: false,
      }),
    );
    child.on("close", (code) =>
      finish({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: timedOut ? -1 : (code ?? -1),
        missing: false,
        timedOut,
      }),
    );
    return Effect.sync(killGroup);
  });

export class GitError extends Schema.TaggedError<GitError, { readonly brand: unique symbol }>()("GitError", {
  code: Schema.Finite,
  stderr: Schema.String,
  message: Schema.String,
}) {
  static of(code: number, stderr: string) {
    return new GitError({ code, stderr, message: stderr.trim() || `git exited ${code}` });
  }
}

export const gitRun = (cwd: string, ...args: string[]) => run("git", args, { cwd });

/** The output, trimmed; a failure is a GitError with what git said. */
export const git = (cwd: string, ...args: string[]): Effect.Effect<string, GitError> =>
  Effect.flatMap(gitRun(cwd, ...args), (r) => (r.code === 0 ? Effect.succeed(r.stdout.trim()) : Effect.fail(GitError.of(r.code, r.stderr))));

export const gitOk = (cwd: string, ...args: string[]) => Effect.map(gitRun(cwd, ...args), (r) => r.code === 0);

/** The output, or "" when git fails. */
export const gitQuiet = (cwd: string, ...args: string[]) => Effect.map(gitRun(cwd, ...args), (r) => (r.code === 0 ? r.stdout.trim() : ""));

/** The first line that says something. */
export const reason = (e: unknown) => {
  const text = messageOf(e);
  return text.split("\n").find((l) => l.trim() !== "") ?? text;
};
