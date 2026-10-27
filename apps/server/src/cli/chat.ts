// The conversations in a terminal: VibeValley's own agent (DeepSeek, with the coding tools, skills, memory, sessions,
// reminders and the MCP servers in a config file), and any runtime on this machine. What is typed while it works joins
// the turn, Ctrl+C stops the turn, and again (idle) quits.

import { standaloneLlm } from "./llm.ts";
import { cliWording } from "./words.ts";
import { instructions } from "./prompts.ts";
import { currentLocale } from "@vibevalley/protocol/words";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Event, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";
import { Brain, type BrainEvent } from "../agent/brain/agent.ts";
import { codingTools } from "../agent/brain/coding.ts";
import { deepseek, readMcpConfig } from "../agent/brain/config.ts";
import { userMessage } from "../agent/brain/messages.ts";
import { vibevalleyRuntimeOf } from "../agent/brain/runtime.ts";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { loadConfig } from "../base/config.ts";
import { dshRuntime } from "../runtime/dsh.ts";
import { registryOf } from "../runtime/runtime.ts";
import { memoryStore } from "../agent/brain/agentTaskStore.ts";
import { wallTime } from "../base/time.ts";
import { plainLog } from "../base/log.ts";

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
      if (e.message.stopReason === "error") write(cliWording().chat.error(e.message.errorMessage ?? ""));
      write("\n");
      return;
    case "tool_execution_start":
      console.log(dim("→ " + e.toolName + " " + short(JSON.stringify(e.args ?? {}))));
      return;
    case "tool_execution_end":
      console.log(dim((e.isError ? "✗ " : "✓ ") + short(e.result.content.map((c) => (c.type === "text" ? c.text : "")).join(""))));
      return;
    case "compaction_end":
      if (e.compaction) console.log(dim(cliWording().chat.compacted(e.compaction.archive ?? "")));
      return;
    case "agent_settled":
      write(dim(cliWording().chat.usage(e.run.aborted, e.run.usage.input, e.run.usage.cacheRead, e.run.usage.output) + "\n"));
      prompt();
      return;
    default:
      break;
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

export interface OwnChat {
  /** The folder it works in; the current one when empty. */
  readonly cwd: string;
  /** Its home under ~/.vibevalley/agent. */
  readonly name: string;
  /** DeepSeek's default when empty. */
  readonly model: string;
  /** The MCP config; <home>/mcp.json when empty. */
  readonly mcp: string;
  /** One question and its answer, no conversation. */
  readonly p?: string;
}

/** The conversation with VibeValley's own agent. */
export async function ownChat(values: OwnChat) {
  const config = await Effect.runPromise(loadConfig().pipe(Effect.provide(NodeServices.layer)));
  const llm = deepseek(values.model || config.agent.model, config.deepseek.apiKey, standaloneLlm());
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const home = join(homedir(), ".vibevalley", "agent", values.name);
  const servers = readMcpConfig(values.mcp || join(home, "mcp.json"));
  const asked = values.p !== undefined;
  // A one-off question keeps no reminders running.
  const agent = await Brain.start({
    time: wallTime,
    log: plainLog,
    name: values.name,
    instructions: instructions(currentLocale()),
    llm,
    home,
    cwd,
    tools: codingTools({ cwd }),
    mcpServers: servers,
    reminders: !asked,
    tasks: memoryStore(),
  });
  for (const why of agent.mcpStatus().failed) console.error(dim(why));
  let prompt = () => {};
  agent.subscribe((e) => show(e, () => prompt()));
  try {
    if (asked) {
      await agent.ask(userMessage(values.p, wallTime.now()));
      return;
    }
    console.log(dim(`vibevalley agent · ${cwd} · ${home}\n` + cliWording().chat.hello(agent.skills().length, agent.mcpStatus().toolCount)));
    prompt = () => write("› ");
    prompt();
    let quit = () => {};
    const ended = new Promise<void>((r) => (quit = r));
    const input = terminal(
      (text) => {
        if (text === "/exit") return quit();
        if (text === "/reset") {
          agent.reset();
          console.log(dim(cliWording().chat.forgot));
          return prompt();
        }
        if (text) agent.send(userMessage(text, wallTime.now()));
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
    default:
      break;
  }
  return undefined;
}

export interface RuntimeChat {
  readonly model?: string;
  readonly effort?: string;
  /** A runtime session to go on with. */
  readonly resume?: string;
  readonly cwd?: string;
  readonly p?: string;
}

/** `runtime chat <runtime>`: a conversation with one runtime, on this machine. It is not VibeValley's work: no issue,
 * any folder, nothing in the core state, the trajectories or the spending. */
export async function runtimeChat(id: string, values: RuntimeChat) {
  if (id === "vibevalley")
    return ownChat({ cwd: values.cwd ?? "", name: "vibevalley", model: values.model ?? "", mcp: "", ...(values.p !== undefined ? { p: values.p } : {}) });
  const config = await Effect.runPromise(loadConfig().pipe(Effect.provide(NodeServices.layer)));
  const on = standaloneLlm();
  const registry = registryOf([
    vibevalleyRuntimeOf({ home: () => config.home, llm: (model) => deepseek(model, config.deepseek.apiKey, on), time: wallTime, log: plainLog }),
    dshRuntime,
  ]);
  const runtime = registry.get(id);
  if (!runtime) throw new Error(cliWording().chat.noRuntime(id));
  if (!runtime.installation) throw new Error(cliWording().chat.unknownInstall(id));
  const found = await runtime.installation();
  if (found.kind !== "available") throw new Error(cliWording().chat.unusable(id, found.kind));
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const session: Session = await runtime.session(found, {
    cwd,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
  });
  try {
    console.log(dim(`${id} · ${session.id}${values.resume ? cliWording().chat.resumed : ""}\n` + cliWording().chat.direct));
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
          if ((run as { kind?: string }).kind === "rejected") console.log(dim(cliWording().chat.rejected(String((run as { reason?: string }).reason ?? ""))));
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
          if ((r as { kind?: string }).kind === "rejected") console.log(dim(cliWording().chat.notSent(String((r as { reason?: string }).reason ?? ""))));
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
