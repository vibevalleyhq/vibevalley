// The conversations in a terminal: VibeValley's own agent (DeepSeek, with the coding tools, skills, memory, sessions,
// reminders and the MCP servers in a config file), and any runtime on this machine. What is typed while it works joins
// the turn, Ctrl+C stops the turn, and again (idle) quits.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Event, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";
import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, FiberHandle, Option, Predicate, Queue, Schema, Stream } from "effect";

import { Brain, type BrainEvent, standaloneOwner } from "@vibevalley/agent/brain";
import { codingTools } from "@vibevalley/agent/coding";
import { readMcpConfig } from "@vibevalley/agent/mcp";
import { userMessage } from "@vibevalley/agent/messages";
import { memoryStore } from "@vibevalley/agent/todoStore";
import { t, currentLocale } from "@vibevalley/i18n";

import { modelClient } from "@/agent/model.ts";
import { messageOf } from "@/errors.ts";
import { loadConfig } from "@/infra/config.ts";
import { wallTime } from "@/infra/time.ts";
import { dshRuntime } from "@/runtime/dsh.ts";
import { registryOf } from "@/runtime/runtime.ts";
import { vibevalleyRuntimeOf } from "@/runtime/vibevalley.ts";

import { standaloneLlm } from "./llm.ts";
import { instructions } from "./prompts.ts";

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
      if (e.message.stopReason === "error") write(t("server.cli.chat.error", { why: e.message.errorMessage ?? "" }));
      write("\n");
      return;
    case "tool_execution_start":
      console.log(dim("→ " + e.toolName + " " + short(JSON.stringify(e.args ?? {}))));
      return;
    case "tool_execution_end":
      console.log(dim((e.isError ? "✗ " : "✓ ") + short(e.result.content.map((c) => (c.type === "text" ? c.text : "")).join(""))));
      return;
    case "compaction_end":
      if (e.compaction) console.log(dim(t("server.cli.chat.compacted", { archive: e.compaction.archive ?? "" })));
      return;
    case "agent_settled":
      write(
        dim(t("server.cli.chat.usage", { aborted: e.run.aborted, input: e.run.usage.input, cached: e.run.usage.cacheRead, output: e.run.usage.output }) + "\n"),
      );
      prompt();
      return;
    default:
      break;
  }
}

type Typed = { readonly kind: "line"; readonly text: string } | { readonly kind: "interrupt" };

/** Lines typed and Ctrl+C, until the input ends. */
const terminal = Stream.callback<Typed>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const rl = createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (l) => Queue.offerUnsafe(queue, { kind: "line", text: l.trim() }));
      rl.on("close", () => Queue.endUnsafe(queue));
      const interrupt = () => Queue.offerUnsafe(queue, { kind: "interrupt" });
      process.on("SIGINT", interrupt);
      return { rl, interrupt };
    }),
    ({ rl, interrupt }) =>
      Effect.sync(() => {
        process.off("SIGINT", interrupt);
        rl.close();
      }),
  ),
);

/** The owner is done: /exit, Ctrl+C with nothing under way, or the input's end. */
class Quit extends Schema.TaggedError<Quit, { readonly brand: unique symbol }>()("Quit", {}) {}

const typed = (handle: (t: Typed) => Effect.Effect<void, Quit>) => Stream.runForEach(terminal, handle).pipe(Effect.catchTag("Quit", () => Effect.void));

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
export const ownChat = (values: OwnChat) =>
  Effect.gen(function* () {
    const config = yield* loadConfig();
    const llm = modelClient(values.model || config.agent.model, config.deepseek.apiKey, standaloneLlm());
    const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
    const home = join(homedir(), ".vibevalley", "agent", values.name);
    const servers = readMcpConfig(values.mcp || join(home, "mcp.json"));
    const asked = values.p !== undefined;
    // A one-off question keeps no reminders running.
    const agent = yield* Brain.make({
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
    agent.subscribe((e) => Effect.sync(() => show(e, () => prompt())));
    const said = (text: string) => Effect.map(Clock.currentTimeMillis, (at) => userMessage(text, at));
    if (values.p !== undefined) {
      yield* agent.ask(yield* said(values.p));
      return;
    }
    console.log(
      dim(`vibevalley agent · ${cwd} · ${home}\n` + t("server.cli.chat.hello", { skills: agent.skills().length, tools: agent.mcpStatus().toolCount })),
    );
    prompt = () => write("› ");
    prompt();
    yield* typed((typedIn) =>
      Effect.gen(function* () {
        if (typedIn.kind === "interrupt") {
          if (!agent.busy()) {
            console.log();
            return yield* new Quit();
          }
          return yield* agent.stop();
        }
        const text = typedIn.text;
        if (text === "/exit") return yield* new Quit();
        if (text === "/reset") {
          yield* agent.reset();
          console.log(dim(t("server.cli.chat.forgot")));
          return prompt();
        }
        if (text) yield* agent.send(yield* said(text));
        else prompt();
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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

/** A conversation with one runtime on this machine: no issue, any folder, and nothing in the core state, trajectories or spending. */
export const runtimeChat = (id: string, values: RuntimeChat): Effect.Effect<void, Effect.Error<ReturnType<typeof ownChat>> | string> =>
  id === "vibevalley"
    ? ownChat({ cwd: values.cwd ?? "", name: "vibevalley", model: values.model ?? "", mcp: "", ...(values.p !== undefined ? { p: values.p } : {}) })
    : Effect.gen(function* () {
        const config = yield* loadConfig().pipe(Effect.provide(NodeServices.layer));
        const service = standaloneLlm();
        const registry = registryOf([
          vibevalleyRuntimeOf({
            home: () => config.home,
            llm: (model) => modelClient(model, config.deepseek.apiKey, service),
            time: wallTime,
            owner: standaloneOwner(),
          }),
          dshRuntime,
        ]);
        const runtime = registry.get(id);
        if (!runtime) return yield* Effect.fail(t("server.cli.chat.noRuntime", { id }));
        const installation = runtime.installation;
        if (!installation) return yield* Effect.fail(t("server.cli.chat.unknownInstall", { id }));
        const found = yield* Effect.tryPromise({ try: () => installation(), catch: messageOf });
        if (found.kind !== "available") return yield* Effect.fail(t("server.cli.chat.unusable", { id, kind: found.kind }));
        const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
        const session: Session = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              runtime.session(found, {
                cwd,
                ...(values.model ? { model: values.model } : {}),
                ...(values.effort ? { effort: values.effort } : {}),
                ...(values.resume ? { resume: values.resume } : {}),
              }),
            catch: messageOf,
          }),
          (s) => Effect.promise(() => s.dispose()),
        );
        console.log(dim(`${id} · ${session.id}${values.resume ? t("server.cli.chat.resumed") : ""}\n` + t("server.cli.chat.direct")));
        session.events(
          (e) => {
            const line = render(e);
            if (line !== undefined) console.log(line);
          },
          { cursor: { sessionId: session.id, afterSeq: -1 } },
        );
        const said = (r: unknown, words: "rejected" | "notSent") => {
          const why = Predicate.hasProperty(r, "reason") && typeof r.reason === "string" ? r.reason : "";
          if (Predicate.hasProperty(r, "kind") && r.kind === "rejected") console.log(dim(t(`server.cli.chat.${words}`, { why })));
        };
        // One turn at a time: a line typed while it runs is steered into it or queued after it. Interrupting the turn's
        // fiber aborts the prompt (its signal).
        const turnOf = (text: string) =>
          Effect.tryPromise({ try: (signal) => promptAndWait(session, text, { signal }), catch: messageOf }).pipe(
            Effect.map((run) => said(run, "rejected")),
            Effect.ensuring(Effect.sync(() => write("› "))),
          );
        if (values.p !== undefined) return yield* turnOf(values.p);
        const turns = yield* FiberHandle.make<void>();
        write("› ");
        yield* typed((typedIn) =>
          Effect.gen(function* () {
            const under = yield* FiberHandle.get(turns);
            const busy = Option.isSome(under) && under.value.pollUnsafe() === undefined;
            if (typedIn.kind === "interrupt") {
              if (!busy) {
                console.log();
                return yield* new Quit();
              }
              return yield* FiberHandle.clear(turns);
            }
            const text = typedIn.text;
            if (text === "/exit") return yield* new Quit();
            if (!text) return busy ? undefined : write("› ");
            if (!busy) return yield* FiberHandle.run(turns, Effect.ignore(turnOf(text)), { onlyIfMissing: false });
            const steering = session.steer ? session.steer(text) : session.queue(text);
            yield* Effect.tryPromise({ try: () => steering, catch: messageOf }).pipe(
              Effect.map((r) => said(r, "notSent")),
              Effect.ignore,
            );
          }),
        );
      }).pipe(Effect.scoped);
