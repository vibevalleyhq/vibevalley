import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import { type Clock, isAbort, reasonOf, systemClock, withTimeout } from "@vibevalley/async";

import { coding as words } from "../base/prompts.ts";
import { errnoOf, messageOf, ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaTool } from "../core/tool.ts";
import { type AgentFs, agentFsOf } from "../infra/fs.ts";
import { afterRealTime } from "../infra/realTime.ts";

export interface CodingOptions {
  readonly cwd: string;
  /** 2 minutes when absent. */
  readonly commandTimeoutMs?: number;
  /** null takes a variable away. */
  readonly env?: Record<string, string | null>;
  readonly fs?: AgentFs;
  /** web_fetch's requests. Default: the global fetch. */
  readonly fetch?: typeof fetch;
  /** web_fetch's time limit. Default: the system clock. */
  readonly clock?: Clock;
}

const why = (e: unknown) => {
  const cause = e instanceof Error && "cause" in e && e.cause !== undefined ? e.cause : e;
  const code = errnoOf(cause) ?? errnoOf(e);
  if (code === "ENOENT") return "no such file or directory";
  if (code === "EISDIR") return "is a directory";
  if (code === "EACCES") return "permission denied";
  return messageOf(e);
};

function withEnv(env: Record<string, string | null> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** code is -1 when killed by a signal. */
export interface Ran {
  readonly code: number;
  readonly output: string;
  readonly timedOut: boolean;
}

const outputCap = 200_000;

/** A command that could not start; code is the system call's (ENOENT…) when there is one. */
class CommandFailed extends Error {
  override readonly name = "CommandFailed";
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Past timeout it gets SIGTERM, and SIGKILL 2 s later; aborted, it is ended at once and the call rejects with the
 * signal's reason. */
function runCommand(argv: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Ran> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new CommandFailed(words.noCommand));
  if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
  return new Promise<Ran>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const take = (b: Buffer) => {
      if (output.length < outputCap) output += b.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    let killer: (() => void) | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid != null && child.pid !== 0) process.kill(-child.pid, sig);
      } catch (e) {
        if (errnoOf(e) !== "ESRCH") throw e;
      }
    };
    const end = () => {
      kill("SIGTERM");
      killer ??= afterRealTime(2_000, () => kill("SIGKILL"));
    };
    const cancelTimer = afterRealTime(timeoutMs, () => {
      timedOut = true;
      end();
    });
    const onAbort = () => {
      end();
      if (signal) reject(reasonOf(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      cancelTimer();
      killer?.();
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      done();
      reject(new CommandFailed(words.cannotRun(e.message), errnoOf(e)));
    });
    // close waits for the output to end; a daemon that left the group may hold it open, so exit gives it 2 s.
    let exited: { code: number } | undefined;
    const finish = () => {
      if (!exited) return;
      done();
      resolve({ code: exited.code, output, timedOut });
    };
    child.on("exit", (code) => {
      exited = { code: code ?? -1 };
      afterRealTime(2_000, finish, { unref: true });
    });
    child.on("close", finish);
  });
}

const localeLess = (a: string, b: string) => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la !== lb ? (la < lb ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
};

const formatSeconds = (ms: number) => String(ms / 1000);

/** A tool's failure as the model reads it: a ToolFailed as it is, an abort as it is, anything else said by message. */
function failedWith(message: (cause: unknown) => string) {
  return (cause: unknown): never => {
    if (cause instanceof ToolFailed || isAbort(cause)) throw cause;
    throw new ToolFailed(message(cause), cause);
  };
}

export function codingTools(o: CodingOptions): Tool[] {
  const cwd = o.cwd;
  const io = agentFsOf(o.fs);
  const clock = o.clock ?? systemClock;
  const timeout = o.commandTimeoutMs ?? 120_000;
  const runEnv = withEnv(o.env);
  const at = (path: string) => (isAbsolute(path) ? path : join(cwd, path));
  const shown = (path: string) => {
    const r = relative(cwd, path);
    return r !== "" && r !== "." && !r.startsWith("..") ? r : path;
  };

  const read = schemaTool({
    name: "read_file",
    description: words.readDescription,
    parameters: z.object({ path: z.string(), offset: z.exactOptional(z.int()), limit: z.exactOptional(z.int()) }),
    run: async (p) => {
      const data = await io.readText(at(p.path)).catch(failedWith((cause) => words.cannotRead(p.path, why(cause))));
      const lines = data.split("\n");
      const from = Math.max(1, p.offset ?? 1);
      const to = Math.min(lines.length, from - 1 + (p.limit ?? 2000));
      const body: string[] = [];
      for (let i = from - 1; i < to; i++) body.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
      const text = body.join("\n");
      return to < lines.length ? text + words.moreLines(lines.length, to) : text;
    },
  });

  const write = schemaTool({
    name: "write_file",
    description: words.writeDescription,
    parameters: z.object({ path: z.string(), content: z.string() }),
    run: async (p) => {
      const file = at(p.path);
      await (async () => {
        await io.makeDir(dirname(file));
        await io.writeText(file, p.content);
      })().catch(failedWith((cause) => words.cannotWrite(p.path, why(cause))));
      return words.wrote(shown(file), p.content.split("\n").length);
    },
  });

  const edit = schemaTool({
    name: "edit_file",
    description: words.editDescription,
    parameters: z.object({ path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.exactOptional(z.boolean()) }),
    run: async (p) => {
      const file = at(p.path);
      const text = await io.readText(file).catch(failedWith((cause) => words.cannotRead(p.path, why(cause))));
      if (p.old_text === "") throw new ToolFailed(words.emptyOldText);
      const count = text.split(p.old_text).length - 1;
      if (count === 0) throw new ToolFailed(words.oldTextNotFound(p.path));
      if (count > 1 && p.replace_all !== true) throw new ToolFailed(words.oldTextNotUnique(p.path, count));
      const next = p.replace_all === true ? text.split(p.old_text).join(p.new_text) : text.replace(p.old_text, () => p.new_text);
      await io.writeText(file, next).catch(failedWith((cause) => words.cannotWrite(p.path, why(cause))));
      return words.edited(shown(file), p.replace_all === true ? count : 1);
    },
  });

  const list = schemaTool({
    name: "list_dir",
    description: words.listDirDescription,
    parameters: z.object({ path: z.exactOptional(z.string()), depth: z.exactOptional(z.int()) }),
    run: async (p) => {
      const path = p.path ?? ".";
      const depth = p.depth ?? 1;
      const out: string[] = [];
      // Depth first, in name order, as the listing reads.
      const walk = async (dir: string, level: number): Promise<void> => {
        const raw = await io.readDirEntries(dir).catch(failedWith((cause) => words.cannotList(path, why(cause))));
        const entries = raw.toSorted((a, b) => localeLess(a.name, b.name));
        for (const e of entries) {
          if (out.length >= 500) return;
          if (e.name === ".git" || e.name === "node_modules") continue;
          out.push("  ".repeat(level) + e.name + (e.isDirectory ? "/" : ""));
          if (e.isDirectory && level + 1 < depth) await walk(join(dir, e.name), level + 1);
        }
      };
      await walk(at(path), 0);
      if (out.length === 0) return words.empty;
      return out.join("\n") + (out.length >= 500 ? words.tooManyNote : "");
    },
  });

  const grep = schemaTool({
    name: "grep",
    description: words.grepDescription,
    parameters: z.object({
      pattern: z.string(),
      path: z.exactOptional(z.string()),
      glob: z.exactOptional(z.string()),
      ignore_case: z.exactOptional(z.boolean()),
    }),
    run: async (p, signal) => {
      const argv = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count=50",
        ...(p.ignore_case === true ? ["-i"] : []),
        ...(p.glob ? ["--glob", p.glob] : []),
        "--",
        p.pattern,
        at(p.path ?? "."),
      ];
      let ran: Ran;
      try {
        ran = await runCommand(argv, cwd, 30_000, runEnv, signal);
      } catch (e) {
        if (!(e instanceof CommandFailed)) throw e;
        throw e.code === "ENOENT" ? new ToolFailed(words.noRipgrep, e) : toolFailed(e);
      }
      return ran.code === 1 || ran.output.trim() === "" ? words.noMatches : ran.output.trim();
    },
  });

  const bash = schemaTool({
    name: "bash",
    description: words.bashDescription(formatSeconds(timeout)),
    parameters: z.object({ command: z.string(), timeout_seconds: z.exactOptional(z.number()) }),
    run: async (p, signal) => {
      const limit = p.timeout_seconds != null && p.timeout_seconds !== 0 ? p.timeout_seconds * 1000 : timeout;
      let ran: Ran;
      try {
        ran = await runCommand(["/bin/bash", "-lc", p.command], cwd, limit, runEnv, signal);
      } catch (e) {
        if (!(e instanceof CommandFailed)) throw e;
        throw toolFailed(e);
      }
      const output = ran.output.trim() || words.noOutput;
      if (ran.timedOut) return output + words.timedOutNote;
      return words.exitCodeNote(output, ran.code);
    },
  });

  const fetchTool = schemaTool({
    name: "web_fetch",
    description: words.webFetchDescription,
    parameters: z.object({ url: z.string() }),
    // A run stopped while it waits aborts the request; the time limit is on the Clock.
    run: async (p, signal) => {
      const fetchFn = o.fetch ?? globalThis.fetch;
      try {
        return await withTimeout(
          async (deadline) => {
            try {
              const res = await fetchFn(p.url, { headers: { "user-agent": "vibevalley-agent/0.1" }, signal: deadline });
              let text = await res.text();
              if ((res.headers.get("content-type") ?? "").includes("html")) text = htmlText(text);
              return `${res.status} ${p.url}\n\n${text}`;
            } catch (cause) {
              if (deadline.aborted) throw cause;
              throw new ToolFailed(words.cannotFetch(p.url, why(cause)), cause);
            }
          },
          30_000,
          { clock, ...(signal !== undefined ? { signal } : {}) },
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "TimeoutError" && signal?.aborted !== true) throw new ToolFailed(words.fetchTimedOut(p.url));
        throw e;
      }
    },
  });

  return [read, write, edit, list, grep, bash, fetchTool];
}

export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
