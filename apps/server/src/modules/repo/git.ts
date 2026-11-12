import { spawn } from "node:child_process";

import { reasonOf } from "@vibevalley/async";

import { errnoOf, messageOf } from "#/base/errors.ts";
import { counter } from "#/infra/metrics.ts";
import { afterRealTime } from "#/infra/time.ts";

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
  /** Aborting kills the command with its children; the call rejects with the abort. */
  readonly signal?: AbortSignal;
}

/** Runs a command to its end. */
export const run = (command: string, args: readonly string[], options: RunOptions = {}): Promise<Ran> => {
  const { signal } = options;
  if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
  return new Promise<Ran>((resolve, reject) => {
    // Its own process group, so a timeout or an abort kills what it started too (a check's test run).
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
      } catch (e) {
        if (errnoOf(e) !== "ESRCH") throw e;
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
    const onAbort = () => {
      if (done || signal === undefined) return;
      done = true;
      cancelTimer?.();
      killGroup();
      reject(reasonOf(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: Ran) => {
      if (done) return;
      done = true;
      cancelTimer?.();
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
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
  });
};

export class GitError extends Error {
  override readonly name = "GitError";
  readonly code: number;
  readonly stderr: string;
  constructor(code: number, stderr: string) {
    super(stderr.trim() || `git exited ${code}`);
    this.code = code;
    this.stderr = stderr;
  }
  static of(code: number, stderr: string) {
    return new GitError(code, stderr);
  }
}

/** Every git command run: what a test holds a path's budget to (listing issues runs none). */
export const gitRuns = counter("vibevalley.git.runs");

/** git's commands, each stopped when signal aborts. */
export const gitWith = (signal?: AbortSignal) => {
  const gitRun = (cwd: string, ...args: string[]): Promise<Ran> => {
    gitRuns.add(1);
    return run("git", args, {
      cwd,
      timeoutMs: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      ...(signal === undefined ? {} : { signal }),
    });
  };
  return {
    gitRun,
    /** The output, trimmed; a failure is a GitError with what git said. */
    git: async (cwd: string, ...args: string[]): Promise<string> => {
      const r = await gitRun(cwd, ...args);
      if (r.code !== 0) throw GitError.of(r.code, r.stderr);
      return r.stdout.trim();
    },
    gitOk: async (cwd: string, ...args: string[]): Promise<boolean> => (await gitRun(cwd, ...args)).code === 0,
    /** The output, or "" when git fails. */
    gitQuiet: async (cwd: string, ...args: string[]): Promise<string> => {
      const r = await gitRun(cwd, ...args);
      return r.code === 0 ? r.stdout.trim() : "";
    },
  };
};

export const { gitRun, git, gitOk, gitQuiet } = gitWith();

/** The first line that says something. */
export const reason = (e: unknown) => {
  const text = messageOf(e);
  return text.split("\n").find((l) => l.trim() !== "") ?? text;
};
