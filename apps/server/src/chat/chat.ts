import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Event, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";

import { type BrainEvent, makeBrain } from "@vibevalley/agent/brain";
import { codingTools } from "@vibevalley/agent/coding";
import { readMcpConfig } from "@vibevalley/agent/mcp";
import { userMessage } from "@vibevalley/agent/messages";
import { memoryStore } from "@vibevalley/agent/todoStore";
import { type Llm, makeLlm } from "@vibevalley/ai/llm";
import { Queue, TaskGroup } from "@vibevalley/async";
import { homeOf } from "@vibevalley/home";
import { t, currentLocale } from "@vibevalley/i18n";

import { messageOf } from "#/base/errors.ts";
import { loadConfig } from "#/infra/config.ts";
import { wallTime } from "#/infra/time.ts";
import { modelClient } from "#/modules/agent/agent.ts";
import { dshRuntime } from "#/modules/runtime/dsh.ts";
import { registryOf } from "#/modules/runtime/runtime.ts";

import { instructions } from "./prompts.ts";

// The command line and the live evals have no farm to give the Llm its fetch: it gets the global one.
export const standaloneLlm = (): Llm => makeLlm();

/** What the user should be told went wrong: said on stderr, and the conversation ends. */
export class ChatRefused extends Error {
  override readonly name = "ChatRefused";
}

const dim = (s: string) => "\x1b[2m" + s + "\x1b[0m";
const short = (s: string) => {
  const r = [...s];
  return (r.length > 120 ? r.slice(0, 120).join("") + "…" : s).split(/\s+/u).filter(Boolean).join(" ");
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
      if (e.message.stopReason === "error") write(t("server.chat.error", { why: e.message.errorMessage ?? "" }));
      write("\n");
      return;
    case "tool_execution_start":
      write(dim("→ " + e.toolName + " " + short(JSON.stringify(e.args ?? {}))) + "\n");
      return;
    case "tool_execution_end":
      write(dim((e.isError ? "✗ " : "✓ ") + short(e.result.content.map((c) => (c.type === "text" ? c.text : "")).join(""))) + "\n");
      return;
    case "compaction_end":
      if (e.compaction) write(dim(t("server.chat.compacted", { archive: e.compaction.archive ?? "" })) + "\n");
      return;
    case "agent_settled":
      write(
        dim(t("server.chat.usage", { aborted: e.run.aborted, input: e.run.usage.input, cached: e.run.usage.cacheRead, output: e.run.usage.output }) + "\n"),
      );
      prompt();
      return;
    default:
      break;
  }
}

type Typed = { readonly kind: "line"; readonly text: string } | { readonly kind: "interrupt" };

/** Lines typed and Ctrl+C, until the input ends or the reader stops. */
async function* terminal(): AsyncGenerator<Typed> {
  const typed = new Queue<Typed>();
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (l) => typed.offer({ kind: "line", text: l.trim() }));
  rl.on("close", () => typed.end());
  const interrupt = () => typed.offer({ kind: "interrupt" });
  process.on("SIGINT", interrupt);
  try {
    yield* typed;
  } finally {
    process.off("SIGINT", interrupt);
    rl.close();
  }
}

/** Each thing typed, handled in order, until handle says the user is done (/exit, Ctrl+C with nothing under way) or the input ends. */
async function typed(handle: (t: Typed) => Promise<"quit" | void>): Promise<void> {
  for await (const typedIn of terminal()) if ((await handle(typedIn)) === "quit") return;
}

interface OwnChat {
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
export async function ownChat(values: OwnChat): Promise<void> {
  const config = await loadConfig();
  const llm = modelClient(values.model || config.agent.model, config.deepseek.apiKey, standaloneLlm());
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const home = join(homeOf(), "agent", values.name);
  const servers = await readMcpConfig(values.mcp || join(home, "mcp.json")).catch((e: unknown) => {
    throw new ChatRefused(messageOf(e), { cause: e });
  });
  const asked = values.p !== undefined;
  // A one-off question keeps no reminders running.
  await using agent = await makeBrain({
    name: values.name,
    instructions: instructions(currentLocale()),
    llm,
    home,
    cwd,
    tools: codingTools({ cwd }),
    mcpServers: servers,
    reminders: !asked,
    todos: memoryStore(),
  });
  for (const why of agent.mcpStatus().failed) console.error(dim(why));
  let prompt = () => {};
  using events = agent.events();
  const said = (text: string) => userMessage(text, wallTime.now());
  if (values.p !== undefined) {
    // The answer is shown to its end before the question's command does.
    const answer = agent.ask(said(values.p));
    for await (const e of events) {
      show(e, () => prompt());
      if (e.type === "agent_settled") break;
    }
    await answer;
    return;
  }
  await using tasks = new TaskGroup({ name: "chat" });
  tasks.run("show", async (signal) => {
    for (let r = await events.next(signal); r.done !== true; r = await events.next(signal)) show(r.value, () => prompt());
  });
  console.log(
    dim(`vibevalley agent · ${cwd} · ${home}\n` + t("server.chat.hello", { skills: (await agent.skills()).length, tools: agent.mcpStatus().toolCount })),
  );
  prompt = () => write("› ");
  prompt();
  await typed(async (typedIn) => {
    if (typedIn.kind === "interrupt") {
      if (!agent.busy()) {
        write("\n");
        return "quit";
      }
      return agent.stop();
    }
    const text = typedIn.text;
    if (text === "/exit") return "quit";
    if (text === "/reset") {
      await agent.reset();
      write(dim(t("server.chat.forgot")) + "\n");
      return prompt();
    }
    if (text) await agent.send(said(text));
    else prompt();
  });
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

interface RuntimeChat {
  readonly model?: string;
  readonly effort?: string;
  /** A runtime session to go on with. */
  readonly resume?: string;
  readonly cwd?: string;
  readonly p?: string;
}

/** A conversation with one runtime on this machine: no issue, any folder, and nothing in the core state, trajectories or spending. */
export async function runtimeChat(id: string, values: RuntimeChat): Promise<void> {
  if (id === "vibevalley")
    return ownChat({ cwd: values.cwd ?? "", name: "vibevalley", model: values.model ?? "", mcp: "", ...(values.p !== undefined ? { p: values.p } : {}) });
  const registry = registryOf([dshRuntime]);
  const runtime = registry.get(id);
  if (!runtime) throw new ChatRefused(t("server.chat.noRuntime", { id }));
  const installation = runtime.installation;
  if (!installation) throw new ChatRefused(t("server.chat.unknownInstall", { id }));
  const found = await installation();
  if (found.kind !== "available") throw new ChatRefused(t("server.chat.unusable", { id, kind: found.kind }));
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  const session: Session = await runtime.session(found, {
    cwd,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
  });
  try {
    write(dim(`${id} · ${session.id}${values.resume ? t("server.chat.resumed") : ""}\n` + t("server.chat.direct")) + "\n");
    session.events(
      (e) => {
        const line = render(e);
        if (line !== undefined) write(line + "\n");
      },
      { cursor: { sessionId: session.id, afterSeq: -1 } },
    );
    const said = (r: unknown, words: "rejected" | "notSent") => {
      const why = typeof r === "object" && r !== null && "reason" in r && typeof r.reason === "string" ? r.reason : "";
      if (typeof r === "object" && r !== null && "kind" in r && r.kind === "rejected") write(dim(t(`server.chat.${words}`, { why })) + "\n");
    };
    // One turn at a time: a line typed while it runs is steered into it or queued after it. Stopping the turn's task
    // aborts the prompt (its signal).
    const turnOf = async (text: string, signal?: AbortSignal) => {
      try {
        said(await promptAndWait(session, text, signal ? { signal } : {}), "rejected");
      } finally {
        write("› ");
      }
    };
    if (values.p !== undefined) return await turnOf(values.p);
    await using turns = new TaskGroup({ name: "chat", onError: (_, e) => write(dim(messageOf(e)) + "\n") });
    write("› ");
    await typed(async (typedIn) => {
      const busy = turns.has("turn");
      if (typedIn.kind === "interrupt") {
        if (!busy) {
          write("\n");
          return "quit";
        }
        return turns.stop("turn");
      }
      const text = typedIn.text;
      if (text === "/exit") return "quit";
      if (!text) {
        if (!busy) write("› ");
        return;
      }
      if (!busy) {
        turns.keyed("turn", (signal) => turnOf(text, signal));
        return;
      }
      try {
        said(await (session.steer ? session.steer(text) : session.queue(text)), "notSent");
      } catch (e) {
        write(dim(messageOf(e)) + "\n");
      }
    });
  } finally {
    await session.dispose();
  }
}
