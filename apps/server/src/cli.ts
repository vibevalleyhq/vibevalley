// VibeValley's command line. With no command, or `runtime chat vibevalley`: the agent on its
// own, in a terminal, a conversation on DeepSeek with the coding tools, skills, memory, sessions, schedules and the MCP
// servers in a config file; what is typed while it works joins the turn, Ctrl+C stops the turn, and again (idle) quits.
// `runtime chat <runtime>` talks to another runtime the same way. Every other command is one of the farm's endpoints,
// called over HTTP; nothing here knows an endpoint by name.
//
//	node --import tsx src/cli.ts [--cwd DIR] [--name NAME] [--model ID] [--mcp FILE] [-p PROMPT]
//	node --import tsx src/cli.ts runtime chat claude
//	node --import tsx src/cli.ts issue list

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Event, Runtime, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";
import { eventsPath, type Issue, statePath } from "@vibevalley/protocol";
import { type Endpoint, endpoints } from "@vibevalley/protocol/api";
import { Brain, type BrainEvent } from "./agent/brain/agent.ts";
import { codingTools } from "./agent/brain/coding.ts";
import { deepseek, readMcpConfig } from "./agent/brain/config.ts";
import { userMessage } from "./agent/brain/messages.ts";
import { vibevalleyRuntimeOf } from "./agent/brain/runtime.ts";
import { loadConfig } from "./base/config.ts";
import { dshRuntime } from "./runtime/dsh.ts";
import { registryOf } from "./runtime/runtime.ts";
import { memoryStore } from "./task/store.ts";

const instructions = `你是 VibeValley，一个在用户电脑上干活的助手：读写代码、跑命令、查资料、记住用户交代的事、按时做定好的事。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要用户拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 用户说「记住」「以后都」时用 remember；说「每天」「到点」「过一会儿」时用 schedule。
- 回答用中文，简短，先说结论。`;

const defaultServer = "http://127.0.0.1:8787";

const dim = (s: string) => "\x1b[2m" + s + "\x1b[0m";
const short = (s: string) => {
  const r = [...s];
  return (r.length > 120 ? r.slice(0, 120).join("") + "…" : s).split(/\s+/).filter(Boolean).join(" ");
};
const write = (s: string) => process.stdout.write(s);

function show(e: BrainEvent, prompt: () => void) {
  switch (e.type) {
    case "message_update": {
      const d = e.assistantMessageEvent;
      if (d.type === "thinking_delta") write(dim(d.delta));
      else if (d.type === "thinking_end") write("\n");
      else if (d.type === "text_delta") write(d.delta);
      return;
    }
    case "message_end":
      if (e.message.role !== "assistant") return;
      if (e.message.stopReason === "error") write("\n出错了：" + (e.message.errorMessage ?? ""));
      write("\n");
      return;
    case "tool_execution_start":
      console.log(dim("→ " + e.toolName + " " + short(JSON.stringify(e.args ?? {}))));
      return;
    case "tool_execution_end":
      console.log(dim((e.isError ? "✗ " : "✓ ") + short(((e.result?.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""))));
      return;
    case "compaction_end":
      if (e.compaction) console.log(dim("（前面的对话压成了摘要，原文在 " + (e.compaction.archive ?? "") + "）"));
      return;
    case "agent_settled":
      write(dim(`（${e.run.aborted ? "停下了，" : ""}输入 ${e.run.usage.input}，缓存 ${e.run.usage.cacheRead}，输出 ${e.run.usage.output}）\n`));
      prompt();
  }
}

/** Lines typed and Ctrl+C, until the input ends. */
function terminal(onLine: (text: string) => void, onInterrupt: () => void): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (l) => onLine(l.trim()));
  process.on("SIGINT", onInterrupt);
  return new Promise((done) =>
    rl.on("close", () => {
      process.off("SIGINT", onInterrupt);
      done();
    }),
  );
}

/** The conversation with VibeValley's own agent. */
async function ownChat(raw: string[]) {
  const { values } = parseArgs({
    args: raw,
    options: {
      cwd: { type: "string", default: "" },
      name: { type: "string", default: "vibevalley" },
      model: { type: "string", default: "" },
      mcp: { type: "string", default: "" },
      p: { type: "string" },
    },
  });
  const config = loadConfig();
  const llm = deepseek(values.model || config.agent.model, config.deepseek.apiKey);
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const home = join(homedir(), ".vibevalley", "agent", values.name!);
  const servers = readMcpConfig(values.mcp || join(home, "mcp.json"));
  const asked = values.p !== undefined;
  // A one-off question keeps no schedules running.
  const agent = await Brain.start({
    name: values.name!,
    instructions,
    llm,
    home,
    cwd,
    tools: codingTools({ cwd }),
    mcpServers: servers,
    schedules: !asked,
    tasks: memoryStore(),
  });
  for (const why of agent.mcpStatus().failed) console.error(dim(why));
  let prompt = () => {};
  agent.subscribe((e) => show(e, () => prompt()));
  try {
    if (asked) {
      await agent.ask(userMessage(values.p!));
      return;
    }
    console.log(
      dim(
        `vibevalley agent · ${cwd} · ${home}\n${agent.skills().length} 个技能，${agent.mcpStatus().toolCount} 个 MCP 工具。/reset 忘掉对话，/exit 退出，Ctrl+C 停下。`,
      ),
    );
    prompt = () => write("› ");
    prompt();
    let quit = () => {};
    const ended = new Promise<void>((r) => (quit = r));
    const input = terminal(
      (text) => {
        if (text === "/exit") return quit();
        if (text === "/reset") {
          agent.reset();
          console.log(dim("忘掉了。"));
          return prompt();
        }
        if (text) agent.send(userMessage(text));
        else prompt();
      },
      () => {
        if (!agent.busy()) {
          console.log();
          return quit();
        }
        void agent.stop();
      },
    );
    await Promise.race([input, ended]);
  } finally {
    await agent.close();
  }
}

/** What a runtime said, as lines. */
function render(e: Event): string | undefined {
  switch (e.kind) {
    case "text_delta":
      write(e.text);
      return undefined;
    case "reasoning":
      return e.content.kind === "text" ? dim(e.content.text) : undefined;
    case "tool_call_started":
      return dim("→ " + e.tool + " " + short(e.input ?? ""));
    case "tool_call_ended":
      return dim((e.result === "failed" ? "✗ " : "✓ ") + short((e.content ?? []).map((c) => ("text" in c ? c.text : "")).join("")));
    case "turn_ended":
      return "";
  }
  return undefined;
}

/** `runtime chat <runtime>`: a conversation with one runtime, on this machine. It is not farm work: no issue, any
 * folder, nothing in the core state, the trajectories or the farm's spending. */
async function runtimeChat(raw: string[]) {
  const id = raw[0];
  if (!id) throw new Error("要哪个农机：vibevalley runtime chat <runtime>（claude、codex、kimi、pi……；vibevalley 是自己的 agent）");
  if (id === "vibevalley") return ownChat(raw.slice(1));
  const { values } = parseArgs({
    args: raw.slice(1),
    options: { model: { type: "string" }, effort: { type: "string" }, resume: { type: "string" }, cwd: { type: "string" }, p: { type: "string" } },
  });
  const config = loadConfig();
  const registry = registryOf([vibevalleyRuntimeOf({ home: () => config.home, llm: (model) => deepseek(model, config.deepseek.apiKey) }), dshRuntime]);
  const runtime = registry.get(id) as Runtime | undefined;
  if (!runtime) throw new Error(`没有 ${id} 这个农机`);
  if (!runtime.installation) throw new Error(`${id} 看不出装没装`);
  const found = await runtime.installation();
  if (found.kind !== "available") throw new Error(`${id} 用不了：${found.kind}`);
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const session: Session = await runtime.session(found, {
    cwd,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
  });
  try {
    console.log(dim(`${id} · ${session.id}${values.resume ? "（接着）" : ""}\n直接聊：不经过农场，不记轨迹和花费。Ctrl+C 停这一轮，空着时再按退出。`));
    session.events(
      (e) => {
        const line = render(e);
        if (line !== undefined) console.log(line);
      },
      { cursor: { sessionId: session.id, afterSeq: -1 } },
    );
    // One turn at a time: a line typed while it runs is steered into it or queued after it.
    let turn: { readonly cancel: () => void; readonly done: Promise<unknown> } | undefined;
    const start = (text: string) => {
      let cancel = () => {};
      const cancelled = new Promise<void>((r) => (cancel = r));
      const done = promptAndWait(session, text, { cancel: cancelled } as never)
        .then((run) => {
          if ((run as { kind?: string }).kind === "rejected") console.log(dim("没接住：" + String((run as { reason?: string }).reason ?? "")));
        })
        .finally(() => {
          turn = undefined;
          write("› ");
        });
      turn = { cancel, done };
    };
    if (values.p !== undefined) {
      start(values.p);
      await turn!.done;
      return;
    }
    write("› ");
    let quit = () => {};
    const ended = new Promise<void>((r) => (quit = r));
    const input = terminal(
      (text) => {
        if (text === "/exit") return quit();
        if (!text) return turn ? undefined : write("› ");
        if (!turn) return start(text);
        void (session.steer ? session.steer(text) : session.queue(text)).then((r) => {
          if ((r as { kind?: string }).kind === "rejected") console.log(dim("没送进去：" + String((r as { reason?: string }).reason ?? "")));
        });
      },
      () => {
        if (!turn) {
          console.log();
          return quit();
        }
        turn.cancel();
      },
    );
    await Promise.race([input, ended]);
  } finally {
    await session.dispose();
  }
}

interface Args {
  readonly words: string[];
  readonly flags: Record<string, string>;
}

/** Flags that take no value. */
const switches = ["watch"];

function wordsOf(raw: readonly string[]): Args {
  const a: Args = { words: [], flags: {} };
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]!;
    if (!w.startsWith("--") || w === "--") {
      a.words.push(w);
      continue;
    }
    const name = w.slice(2);
    const eq = name.indexOf("=");
    if (eq >= 0) a.flags[name.slice(0, eq)] = name.slice(eq + 1);
    else if (switches.includes(name)) a.flags[name] = "true";
    else {
      if (i + 1 >= raw.length) throw new Error(`--${name} 后面要一个值`);
      a.flags[name] = raw[++i]!;
    }
  }
  return a;
}

const serverOf = (a: Args) => a.flags.server || process.env.VIBEVALLEY_SERVER || defaultServer;

/** How a command writes an op: editNode is edit-node. */
const kebab = (op: string) => op.replace(/[A-Z]/g, (c, i: number) => (i > 0 ? "-" : "") + c.toLowerCase());

const endpointOf = (group: string, op: string) => endpoints.find((e) => e.op.split(".")[0] === group && kebab(e.op.split(".")[1]!) === op);
const isGroup = (word: string) => endpoints.some((e) => e.op.startsWith(word + "."));
const placeholders = (e: Endpoint) => e.pathParams.map((p) => `<${p.name}>`).join(" ");
const flagsOf = (e: Endpoint) => [...e.query.map((q) => "--" + q.name), ...(e.body ? ["--json"] : [])];

const printJSON = (text: string) => {
  if (text.trim() === "") return;
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
};

async function request(base: string, method: string, path: string, body?: string) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.trim();
    try {
      const j = JSON.parse(text) as { reason?: string; what?: string; _tag?: string };
      reason = j.reason ?? j.what ?? j._tag ?? reason;
    } catch {
      // As it came.
    }
    throw new Error(`${res.status} ${reason}`);
  }
  return text;
}

/** One farm command: words[0] is the group, words[1] the op. */
async function call(raw: string[]) {
  const a = wordsOf(raw);
  if (a.words.length < 2) return usage(a.words[0]);
  const e = endpointOf(a.words[0]!, a.words[1]!);
  if (!e) {
    usage(a.words[0]);
    throw new Error(`没有 ${a.words[0]} ${a.words[1]}`);
  }
  const given = a.words.slice(2);
  if (given.length !== e.pathParams.length) throw new Error(`${e.op} 要 ${e.pathParams.length} 个参数（${placeholders(e)}），给了 ${given.length} 个`);
  let i = 0;
  const path = e.path.replace(/\{(\w+)\}/g, () => encodeURIComponent(given[i++]!));
  const q = new URLSearchParams();
  for (const p of e.query) if (a.flags[p.name] !== undefined) q.set(p.name, a.flags[p.name]!);
  for (const name of Object.keys(a.flags))
    if (!e.query.some((p) => p.name === name) && name !== "server" && name !== "json") {
      const known = flagsOf(e);
      throw new Error(known.length > 0 ? `${e.op} 不认 --${name}（认的：${known.join(" ")}）` : `${e.op} 不带参数，不认 --${name}`);
    }
  let body: string | undefined;
  if (e.body) {
    const v = a.flags.json ?? "";
    body = v === "" ? "{}" : v === "-" ? await new Response(process.stdin as never).text() : v;
    try {
      JSON.parse(body);
    } catch {
      throw new Error("--json 不是 JSON");
    }
  } else if (a.flags.json !== undefined) throw new Error(`${e.op} 不带请求体`);
  printJSON(await request(serverOf(a), e.method, path + (q.size > 0 ? "?" + q.toString() : ""), body));
}

/** /api/v1/state or /api/v1/events: the first frame, or every one with --watch (events are always watched). */
async function stream(path: string, raw: string[]) {
  const a = wordsOf(raw);
  const watch = path === eventsPath || a.flags.watch === "true";
  const res = await fetch(serverOf(a) + path, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      printJSON(data);
      if (!watch) return;
    }
  }
}

/** `issue run <id>`: move a backlog issue to todo, wait while it waits for room or is worked, then print its changes.
 * One already sent is only waited for. It ends in review, done or canceled; each status it passes goes to stderr. */
async function issueRun(raw: string[], pollMs = 2_000) {
  const a = wordsOf(raw);
  if (a.words.length !== 1) throw new Error("用法：vibevalley issue run <id>");
  const base = serverOf(a);
  const id = encodeURIComponent(a.words[0]!);
  const get = async () => JSON.parse(await request(base, "GET", `/api/v1/issues/${id}`)) as Issue;
  if ((await get()).status === "backlog") await request(base, "PUT", `/api/v1/issues/${id}/status`, JSON.stringify({ status: "todo" }));
  let last = "";
  for (;;) {
    const issue = await get();
    if (issue.status !== last) {
      console.error(issue.status);
      last = issue.status;
    }
    if (issue.status === "in_review" || issue.status === "done" || issue.status === "canceled")
      return printJSON(await request(base, "GET", `/api/v1/issues/${id}/changes`));
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function usage(only?: string) {
  if (!only)
    console.log(`用法：
  vibevalley                                 和 VibeValley 自己的 agent 聊（runtime chat vibevalley）
  vibevalley runtime chat <runtime> [--model --effort --resume --cwd -p]
                                             和一个农机直接聊，不经过农场
  vibevalley issue run <id>                  备选的挪到待办，等它交回来，打出改动
  vibevalley state [--watch]                 核心状态（GET ${statePath}）
  vibevalley events                          副作用（GET ${eventsPath}）
  vibevalley <group> <op> [参数…] [--json 请求体|-]
                                             调农场的一个接口，答复是 JSON

  --server 地址，或 VIBEVALLEY_SERVER，默认 ${defaultServer}。能力表：docs/reference/capabilities.md
`);
  const groups = [...new Set(endpoints.map((e) => e.op.split(".")[0]!))].filter((g) => !only || g === only);
  for (const g of groups)
    for (const e of endpoints.filter((x) => x.op.split(".")[0] === g))
      console.log("  " + [g, kebab(e.op.split(".")[1]!), placeholders(e), flagsOf(e).join(" ")].filter(Boolean).join(" "));
}

export async function dispatch(raw: string[]) {
  const [first] = raw;
  if (first === undefined || (first.startsWith("-") && first !== "--help")) return ownChat(raw);
  if (first === "help" || first === "--help") return usage();
  if (first === "issue" && raw[1] === "run") return issueRun(raw.slice(2));
  if (first === "runtime" && raw[1] === "chat") return runtimeChat(raw.slice(2));
  if (first === "state") return stream(statePath, raw.slice(1));
  if (first === "events") return stream(eventsPath, raw.slice(1));
  if (isGroup(first)) return call(raw);
  usage();
  throw new Error(`没有 ${first} 这个命令`);
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  dispatch(process.argv.slice(2)).then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
