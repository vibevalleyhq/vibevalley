import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative } from "node:path";

import { Effect, type FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { coding as words } from "../base/prompts.ts";
import { errnoOf, messageOf, ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaEffectTool } from "../core/tool.ts";
import { agentFsOf } from "../infra/fs.ts";
import { afterRealTime } from "../infra/realTime.ts";

export interface CodingOptions {
  readonly cwd: string;
  /** 2 minutes when absent. */
  readonly commandTimeoutMs?: number;
  /** null takes a variable away. */
  readonly env?: Record<string, string | null>;
  readonly fs?: FileSystem.FileSystem;
  readonly http?: HttpClient.HttpClient;
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
class CommandFailed extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {}

/** Past timeout it gets SIGTERM, and SIGKILL 2 s later; interrupted, it goes at once. */
function runCommand(argv: readonly string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Effect.Effect<Ran, CommandFailed> {
  const [command, ...args] = argv;
  if (!command) return Effect.fail(CommandFailed.make({ message: words.noCommand }));
  return Effect.callback<Ran, CommandFailed>((resume) => {
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
    const done = () => {
      cancelTimer();
      killer?.();
    };
    child.on("error", (e) => {
      done();
      const code = errnoOf(e);
      resume(Effect.fail(CommandFailed.make({ message: words.cannotRun(e.message), ...(code === undefined ? {} : { code }) })));
    });
    // close waits for the output to end; a daemon that left the group may hold it open, so exit gives it 2 s.
    let exited: { code: number } | undefined;
    const finish = () => {
      if (!exited) return;
      done();
      resume(Effect.succeed({ code: exited.code, output, timedOut }));
    };
    child.on("exit", (code) => {
      exited = { code: code ?? -1 };
      afterRealTime(2_000, finish, { unref: true });
    });
    child.on("close", finish);
    return Effect.sync(end);
  });
}

const localeLess = (a: string, b: string) => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la !== lb ? (la < lb ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
};

const formatSeconds = (ms: number) => String(ms / 1000);

let fallbackHttp: HttpClient.HttpClient | undefined;
const standaloneHttp = (): HttpClient.HttpClient =>
  (fallbackHttp ??= Effect.runSync(Effect.provide(Effect.service(HttpClient.HttpClient), FetchHttpClient.layer)));

export function codingTools(o: CodingOptions): Tool[] {
  const cwd = o.cwd;
  const io = agentFsOf(o.fs);
  const timeout = o.commandTimeoutMs ?? 120_000;
  const runEnv = withEnv(o.env);
  const at = (path: string) => (isAbsolute(path) ? path : join(cwd, path));
  const shown = (path: string) => {
    const r = relative(cwd, path);
    return r !== "" && r !== "." && !r.startsWith("..") ? r : path;
  };

  const read = schemaEffectTool({
    name: "read_file",
    description: words.readDescription,
    parameters: Schema.Struct({ path: Schema.String, offset: Schema.optionalKey(Schema.Int), limit: Schema.optionalKey(Schema.Int) }),
    run: (p) =>
      Effect.gen(function* () {
        const data = yield* io.readText(at(p.path)).pipe(Effect.mapError((cause) => ToolFailed.make({ message: words.cannotRead(p.path, why(cause)), cause })));
        const lines = data.split("\n");
        const from = Math.max(1, p.offset ?? 1);
        const to = Math.min(lines.length, from - 1 + (p.limit ?? 2000));
        const body: string[] = [];
        for (let i = from - 1; i < to; i++) body.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
        const text = body.join("\n");
        return to < lines.length ? text + words.moreLines(lines.length, to) : text;
      }),
  });

  const write = schemaEffectTool({
    name: "write_file",
    description: words.writeDescription,
    parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
    run: (p) =>
      Effect.gen(function* () {
        const file = at(p.path);
        yield* Effect.andThen(io.makeDir(dirname(file)), io.writeText(file, p.content)).pipe(
          Effect.mapError((cause) => ToolFailed.make({ message: words.cannotWrite(p.path, why(cause)), cause })),
        );
        return words.wrote(shown(file), p.content.split("\n").length);
      }),
  });

  const edit = schemaEffectTool({
    name: "edit_file",
    description: words.editDescription,
    parameters: Schema.Struct({ path: Schema.String, old_text: Schema.String, new_text: Schema.String, replace_all: Schema.optionalKey(Schema.Boolean) }),
    run: (p) =>
      Effect.gen(function* () {
        const file = at(p.path);
        const text = yield* io.readText(file).pipe(Effect.mapError((cause) => ToolFailed.make({ message: words.cannotRead(p.path, why(cause)), cause })));
        if (p.old_text === "") return yield* ToolFailed.make({ message: words.emptyOldText });
        const count = text.split(p.old_text).length - 1;
        if (count === 0) return yield* ToolFailed.make({ message: words.oldTextNotFound(p.path) });
        if (count > 1 && p.replace_all !== true) return yield* ToolFailed.make({ message: words.oldTextNotUnique(p.path, count) });
        const next = p.replace_all === true ? text.split(p.old_text).join(p.new_text) : text.replace(p.old_text, () => p.new_text);
        yield* io.writeText(file, next).pipe(Effect.mapError((cause) => ToolFailed.make({ message: words.cannotWrite(p.path, why(cause)), cause })));
        return words.edited(shown(file), p.replace_all === true ? count : 1);
      }),
  });

  const list = schemaEffectTool({
    name: "list_dir",
    description: words.listDirDescription,
    parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String), depth: Schema.optionalKey(Schema.Int) }),
    run: (p) =>
      Effect.gen(function* () {
        const path = p.path ?? ".";
        const depth = p.depth ?? 1;
        const out: string[] = [];
        // Depth first, in name order, as the listing reads.
        const walk = (dir: string, level: number): Effect.Effect<void, ToolFailed> =>
          Effect.gen(function* () {
            const raw = yield* io.readDirEntries(dir).pipe(Effect.mapError((cause) => ToolFailed.make({ message: words.cannotList(path, why(cause)), cause })));
            const entries = raw.toSorted((a, b) => localeLess(a.name, b.name));
            for (const e of entries) {
              if (out.length >= 500) return;
              if (e.name === ".git" || e.name === "node_modules") continue;
              out.push("  ".repeat(level) + e.name + (e.isDirectory ? "/" : ""));
              if (e.isDirectory && level + 1 < depth) yield* walk(join(dir, e.name), level + 1);
            }
          });
        yield* walk(at(path), 0);
        if (out.length === 0) return words.empty;
        return out.join("\n") + (out.length >= 500 ? words.tooManyNote : "");
      }),
  });

  const grep = schemaEffectTool({
    name: "grep",
    description: words.grepDescription,
    parameters: Schema.Struct({
      pattern: Schema.String,
      path: Schema.optionalKey(Schema.String),
      glob: Schema.optionalKey(Schema.String),
      ignore_case: Schema.optionalKey(Schema.Boolean),
    }),
    run: (p) => {
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
      return runCommand(argv, cwd, 30_000, runEnv).pipe(
        Effect.mapBoth({
          onSuccess: (ran) => (ran.code === 1 || ran.output.trim() === "" ? words.noMatches : ran.output.trim()),
          onFailure: (e) => (e.code === "ENOENT" ? ToolFailed.make({ message: words.noRipgrep, cause: e }) : toolFailed(e)),
        }),
      );
    },
  });

  const bash = schemaEffectTool({
    name: "bash",
    description: words.bashDescription(formatSeconds(timeout)),
    parameters: Schema.Struct({ command: Schema.String, timeout_seconds: Schema.optionalKey(Schema.Finite) }),
    run: (p) => {
      const limit = p.timeout_seconds != null && p.timeout_seconds !== 0 ? p.timeout_seconds * 1000 : timeout;
      return runCommand(["/bin/bash", "-lc", p.command], cwd, limit, runEnv).pipe(
        Effect.mapBoth({
          onSuccess: (ran) => {
            const output = ran.output.trim() || words.noOutput;
            if (ran.timedOut) return output + words.timedOutNote;
            return words.exitCodeNote(output, ran.code);
          },
          onFailure: toolFailed,
        }),
      );
    },
  });

  const fetchTool = schemaEffectTool({
    name: "web_fetch",
    description: words.webFetchDescription,
    parameters: Schema.Struct({ url: Schema.String }),
    // A run stopped while it waits interrupts the request; the time limit is on the Clock.
    run: (p) =>
      Effect.gen(function* () {
        const http = o.http ?? standaloneHttp();
        const res = yield* http.execute(HttpClientRequest.get(p.url).pipe(HttpClientRequest.setHeader("user-agent", "vibevalley-agent/0.1")));
        let text = yield* res.text;
        if ((res.headers["content-type"] ?? "").includes("html")) text = htmlText(text);
        return `${res.status} ${p.url}\n\n${text}`;
      }).pipe(
        Effect.mapError((cause) => ToolFailed.make({ message: words.cannotFetch(p.url, why(cause)), cause })),
        Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(ToolFailed.make({ message: words.fetchTimedOut(p.url) })) }),
      ),
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
