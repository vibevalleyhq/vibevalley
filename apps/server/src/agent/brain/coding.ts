// Tools to read and change a work directory and run commands in it. No sandbox: a host gives these only to agents that
// are meant to change things (not the orchestrator).

import type { Tool } from "../loop/agent.ts";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { schemaTool, stopped } from "./tool.ts";
import { Schema } from "effect";
import { afterRealTime } from "./realTime.ts";
import { coding as words } from "./prompts.ts";

export interface CodingOptions {
  readonly cwd: string;
  /** 2 minutes when absent. */
  readonly commandTimeoutMs?: number;
  /** null takes a variable away. */
  readonly env?: Record<string, string | null>;
}

const why = (e: unknown) => {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return "no such file or directory";
  if (err?.code === "EISDIR") return "is a directory";
  if (err?.code === "EACCES") return "permission denied";
  return err instanceof Error ? err.message : String(e);
};

export function withEnv(env: Record<string, string | null> = {}): NodeJS.ProcessEnv {
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

/** Past timeout it gets SIGTERM, and SIGKILL 2 s later; when signal aborts it goes at once. The whole process group is
 * killed, so a child left behind does not hold the output open. */
export function runCommand(argv: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Ran> {
  if (argv.length === 0) return Promise.reject(new Error(words.noCommand));
  if (signal?.aborted) return Promise.reject(new Error(stopped));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
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
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Gone already.
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
    signal?.addEventListener("abort", end, { once: true });
    const done = () => {
      cancelTimer();
      killer?.();
      signal?.removeEventListener("abort", end);
    };
    child.on("error", (e) => {
      done();
      reject(
        Object.assign(new Error(words.cannotRun(e.message)), {
          code: (e as NodeJS.ErrnoException).code,
        }),
      );
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

export function codingTools(o: CodingOptions): Tool[] {
  const cwd = o.cwd;
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
    parameters: Schema.Struct({ path: Schema.String, offset: Schema.optionalKey(Schema.Int), limit: Schema.optionalKey(Schema.Int) }),
    run: (p) => {
      let data: string;
      try {
        data = readFileSync(at(p.path), "utf8");
      } catch (e) {
        throw new Error(words.cannotRead(p.path, why(e)), { cause: e });
      }
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
    parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
    run: (p) => {
      const file = at(p.path);
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, p.content);
      } catch (e) {
        throw new Error(words.cannotWrite(p.path, why(e)), { cause: e });
      }
      return words.wrote(shown(file), p.content.split("\n").length);
    },
  });

  const edit = schemaTool({
    name: "edit_file",
    description: words.editDescription,
    parameters: Schema.Struct({ path: Schema.String, old_text: Schema.String, new_text: Schema.String, replace_all: Schema.optionalKey(Schema.Boolean) }),
    run: (p) => {
      const file = at(p.path);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        throw new Error(words.cannotRead(p.path, why(e)), { cause: e });
      }
      if (p.old_text === "") throw new Error(words.emptyOldText);
      const count = text.split(p.old_text).length - 1;
      if (count === 0) throw new Error(words.oldTextNotFound(p.path));
      if (count > 1 && !p.replace_all) throw new Error(words.oldTextNotUnique(p.path, count));
      const next = p.replace_all ? text.split(p.old_text).join(p.new_text) : text.replace(p.old_text, () => p.new_text);
      try {
        writeFileSync(file, next);
      } catch (e) {
        throw new Error(words.cannotWrite(p.path, why(e)), { cause: e });
      }
      return words.edited(shown(file), p.replace_all ? count : 1);
    },
  });

  const list = schemaTool({
    name: "list_dir",
    description: words.listDirDescription,
    parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String), depth: Schema.optionalKey(Schema.Int) }),
    run: (p) => {
      const path = p.path ?? ".";
      const depth = p.depth ?? 1;
      const out: string[] = [];
      const walk = (dir: string, level: number) => {
        const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => localeLess(a.name, b.name));
        for (const e of entries) {
          if (out.length >= 500) return;
          if (e.name === ".git" || e.name === "node_modules") continue;
          const isDir = e.isDirectory();
          out.push("  ".repeat(level) + e.name + (isDir ? "/" : ""));
          if (isDir && level + 1 < depth) walk(join(dir, e.name), level + 1);
        }
      };
      try {
        walk(at(path), 0);
      } catch (e) {
        throw new Error(words.cannotList(path, why(e)), { cause: e });
      }
      if (out.length === 0) return words.empty;
      return out.join("\n") + (out.length >= 500 ? words.tooManyNote : "");
    },
  });

  const grep = schemaTool({
    name: "grep",
    description: words.grepDescription,
    parameters: Schema.Struct({
      pattern: Schema.String,
      path: Schema.optionalKey(Schema.String),
      glob: Schema.optionalKey(Schema.String),
      ignore_case: Schema.optionalKey(Schema.Boolean),
    }),
    run: async (p, tc) => {
      const argv = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count=50",
        ...(p.ignore_case ? ["-i"] : []),
        ...(p.glob ? ["--glob", p.glob] : []),
        "--",
        p.pattern,
        at(p.path ?? "."),
      ];
      let ran: Ran;
      try {
        ran = await runCommand(argv, cwd, 30_000, runEnv, tc.signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(words.noRipgrep, { cause: e });
        throw e;
      }
      if (ran.code === 1 || ran.output.trim() === "") return words.noMatches;
      return ran.output.trim();
    },
  });

  const bash = schemaTool({
    name: "bash",
    description: words.bashDescription(formatSeconds(timeout)),
    parameters: Schema.Struct({ command: Schema.String, timeout_seconds: Schema.optionalKey(Schema.Number) }),
    run: async (p, tc) => {
      const limit = p.timeout_seconds ? p.timeout_seconds * 1000 : timeout;
      const ran = await runCommand(["/bin/bash", "-lc", p.command], cwd, limit, runEnv, tc.signal);
      const output = ran.output.trim() || words.noOutput;
      if (ran.timedOut) return output + words.timedOutNote;
      return words.exitCodeNote(output, ran.code);
    },
  });

  const fetchTool = schemaTool({
    name: "web_fetch",
    description: words.webFetchDescription,
    parameters: Schema.Struct({ url: Schema.String }),
    run: async (p, tc) => {
      const timeoutSignal = AbortSignal.timeout(30_000);
      let res: Response;
      try {
        res = await fetch(p.url, {
          headers: { "user-agent": "vibevalley-agent/0.1" },
          signal: AbortSignal.any([tc.signal, timeoutSignal]),
        });
      } catch (e) {
        if (timeoutSignal.aborted) throw new Error(words.fetchTimedOut(p.url), { cause: e });
        throw new Error(words.cannotFetch(p.url, why(e)), { cause: e });
      }
      let text = await res.text();
      if ((res.headers.get("content-type") ?? "").includes("html")) text = htmlText(text);
      return `${res.status} ${p.url}\n\n${text}`;
    },
  });

  return [read, write, edit, list, grep, bash, fetchTool];
}

export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
