// Tools to read and change a work directory and run commands in it. No sandbox: a host gives these only to agents that
// are meant to change things (not the manager).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { booleanSchema, integerSchema, numberSchema, objectSchema, stringSchema, textTool } from "./tool.ts";

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
  if (argv.length === 0) return Promise.reject(new Error("跑不起来：没有命令"));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (b: Buffer) => {
      if (output.length < outputCap) output += b.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Gone already.
      }
    };
    const end = () => {
      kill("SIGTERM");
      killer ??= setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, timeoutMs);
    signal?.addEventListener("abort", end, { once: true });
    const done = () => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      signal?.removeEventListener("abort", end);
    };
    child.on("error", (e) => {
      done();
      reject(Object.assign(new Error("跑不起来：" + e.message), { code: (e as NodeJS.ErrnoException).code }));
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
      setTimeout(finish, 2_000).unref();
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

export function codingTools(o: CodingOptions): AgentTool[] {
  const cwd = o.cwd;
  const timeout = o.commandTimeoutMs ?? 120_000;
  const runEnv = withEnv(o.env);
  const at = (path: string) => (isAbsolute(path) ? path : join(cwd, path));
  const shown = (path: string) => {
    const r = relative(cwd, path);
    return r !== "" && r !== "." && !r.startsWith("..") ? r : path;
  };

  const read = textTool<{ path: string; offset?: number; limit?: number }>({
    name: "read_file",
    description: "读一个文本文件，每行前面带行号。大文件用 offset（从第几行开始，1 起）和 limit（读几行）分段读。",
    parameters: objectSchema({ path: stringSchema(), offset: integerSchema(), limit: integerSchema() }, "path"),
    run: (p) => {
      let data: string;
      try {
        data = readFileSync(at(p.path), "utf8");
      } catch (e) {
        throw new Error(`读不了 ${p.path}：${why(e)}`);
      }
      const lines = data.split("\n");
      const from = Math.max(1, p.offset ?? 1);
      const to = Math.min(lines.length, from - 1 + (p.limit ?? 2000));
      const body: string[] = [];
      for (let i = from - 1; i < to; i++) body.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
      const text = body.join("\n");
      return to < lines.length ? `${text}\n（共 ${lines.length} 行，这里到第 ${to} 行；接着读用 offset=${to + 1}）` : text;
    },
  });

  const write = textTool<{ path: string; content: string }>({
    name: "write_file",
    description: "写一个文件（整个覆盖；没有的目录会建好）。改已有文件的一部分用 edit_file。",
    parameters: objectSchema({ path: stringSchema(), content: stringSchema() }, "path", "content"),
    run: (p) => {
      const file = at(p.path);
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, p.content);
      } catch (e) {
        throw new Error(`写不了 ${p.path}：${why(e)}`);
      }
      return `写好了 ${shown(file)}（${p.content.split("\n").length} 行）`;
    },
  });

  const edit = textTool<{ path: string; old_text: string; new_text: string; replace_all?: boolean }>({
    name: "edit_file",
    description: "把文件里的一段原文换成新的。old_text 要和文件里一字不差、而且只出现一次（不唯一就多带几行上下文），要全换就把 replace_all 设成 true。",
    parameters: objectSchema(
      { path: stringSchema(), old_text: stringSchema(), new_text: stringSchema(), replace_all: booleanSchema() },
      "path",
      "old_text",
      "new_text",
    ),
    run: (p) => {
      const file = at(p.path);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        throw new Error(`读不了 ${p.path}：${why(e)}`);
      }
      if (p.old_text === "") throw new Error("old_text 是空的：要新建文件用 write_file。");
      const count = text.split(p.old_text).length - 1;
      if (count === 0) throw new Error(`${p.path} 里找不到 old_text：先 read_file 看清原文（空格、缩进都要一样）。`);
      if (count > 1 && !p.replace_all) throw new Error(`old_text 在 ${p.path} 里出现了 ${count} 次：多带几行上下文让它唯一，或者设 replace_all。`);
      const next = p.replace_all ? text.split(p.old_text).join(p.new_text) : text.replace(p.old_text, () => p.new_text);
      try {
        writeFileSync(file, next);
      } catch (e) {
        throw new Error(`写不了 ${p.path}：${why(e)}`);
      }
      return `改好了 ${shown(file)}（换了 ${p.replace_all ? count : 1} 处）`;
    },
  });

  const list = textTool<{ path?: string; depth?: number }>({
    name: "list_dir",
    description: "列一个目录里有什么（目录后面带 /）。depth 是往下看几层，默认 1。不进 .git、node_modules。",
    parameters: objectSchema({ path: stringSchema(), depth: integerSchema() }),
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
        throw new Error(`列不了 ${path}：${why(e)}`);
      }
      if (out.length === 0) return "（空的）";
      return out.join("\n") + (out.length >= 500 ? "\n…（太多了，只列了 500 个）" : "");
    },
  });

  const grep = textTool<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean }>({
    name: "grep",
    description: "在文件里搜一个正则，返回「文件:行号:那一行」。path 默认工作目录；glob 只搜某些文件，比如 *.ts。",
    parameters: objectSchema({ pattern: stringSchema(), path: stringSchema(), glob: stringSchema(), ignore_case: booleanSchema() }, "pattern"),
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
        if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。");
        throw e;
      }
      if (ran.code === 1 || ran.output.trim() === "") return "没搜到。";
      return ran.output.trim();
    },
  });

  const bash = textTool<{ command: string; timeout_seconds?: number }>({
    name: "bash",
    description: `在工作目录里跑一条 shell 命令，返回它的输出和退出码。默认 ${formatSeconds(timeout)} 秒超时，可以用 timeout_seconds 改。不要用它读写文件（用 read_file、edit_file），不要起不会结束的进程。`,
    parameters: objectSchema({ command: stringSchema(), timeout_seconds: numberSchema() }, "command"),
    run: async (p, tc) => {
      const limit = p.timeout_seconds ? p.timeout_seconds * 1000 : timeout;
      const ran = await runCommand(["/bin/bash", "-lc", p.command], cwd, limit, runEnv, tc.signal);
      const output = ran.output.trim() || "（没有输出）";
      if (ran.timedOut) return output + "\n（超时，停掉了）";
      return `${output}\n（退出码 ${ran.code}）`;
    },
  });

  const fetchTool = textTool<{ url: string }>({
    name: "web_fetch",
    description: "打开一个网页，返回它的正文（HTML 变成纯文本）。",
    parameters: objectSchema({ url: stringSchema() }, "url"),
    run: async (p, tc) => {
      const timeoutSignal = AbortSignal.timeout(30_000);
      let res: Response;
      try {
        res = await fetch(p.url, { headers: { "user-agent": "vibevalley-agent/0.1" }, signal: AbortSignal.any([tc.signal, timeoutSignal]) });
      } catch (e) {
        if (timeoutSignal.aborted) throw new Error(`打开 ${p.url} 超时了`);
        throw new Error(`打不开 ${p.url}：${why(e)}`);
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
