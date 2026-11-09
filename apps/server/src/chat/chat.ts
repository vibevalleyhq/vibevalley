import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Event, Session } from "@botiverse/oar";
import { promptAndWait } from "@botiverse/oar/observe";
import { NodeServices } from "@effect/platform-node";
import { Clock, Console, Effect, Fiber, FiberHandle, Formatter, Option, Predicate, Queue, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { type BrainEvent, makeBrain } from "@vibevalley/agent/brain";
import { codingTools } from "@vibevalley/agent/coding";
import { readMcpConfig } from "@vibevalley/agent/mcp";
import { userMessage } from "@vibevalley/agent/messages";
import { memoryStore } from "@vibevalley/agent/todoStore";
import { type Llm, make } from "@vibevalley/ai/llm";
import { homeOf } from "@vibevalley/home";
import { t, currentLocale } from "@vibevalley/i18n";

import { modelClient } from "#/agent/agent.ts";
import { messageOf } from "#/base/errors.ts";
import { loadConfig } from "#/infra/config.ts";
import { dshRuntime } from "#/runtime/dsh.ts";
import { registryOf } from "#/runtime/runtime.ts";

import { instructions } from "./prompts.ts";

// The command line and the live evals have no farm to give the Llm its HttpClient: it gets a fetch of its own.
export const standaloneLlm = (): Llm["Service"] => Effect.runSync(make.pipe(Effect.provide(FetchHttpClient.layer)));

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
      write(dim("→ " + e.toolName + " " + short(Formatter.formatJson(e.args ?? {}))) + "\n");
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
export const ownChat = (values: OwnChat) =>
  Effect.gen(function* () {
    const config = yield* loadConfig();
    const llm = modelClient(values.model || config.agent.model, config.deepseek.apiKey, standaloneLlm());
    const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
    const home = join(homeOf(), "agent", values.name);
    const servers = yield* Effect.tryPromise({ try: () => readMcpConfig(values.mcp || join(home, "mcp.json")), catch: messageOf });
    const asked = values.p !== undefined;
    // A one-off question keeps no reminders running.
    const agent = yield* makeBrain({
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
    yield* Effect.forEach(agent.mcpStatus().failed, (why) => Console.error(dim(why)), { discard: true });
    let prompt = () => {};
    const events = yield* agent.events;
    const shown = (e: BrainEvent) => Effect.sync(() => show(e, () => prompt()));
    const said = (text: string) => Effect.map(Clock.currentTimeMillis, (at) => userMessage(text, at));
    if (values.p !== undefined) {
      const said2 = yield* said(values.p);
      // The answer is shown to its end before the question's command does.
      const answer = yield* Effect.forkChild(agent.ask(said2));
      yield* Stream.runForEach(
        Stream.takeUntil(events, (e) => e.type === "agent_settled"),
        shown,
      );
      yield* Fiber.join(answer);
      return;
    }
    yield* Effect.forkScoped(Stream.runForEach(events, shown));
    yield* Console.log(
      dim(`vibevalley agent · ${cwd} · ${home}\n` + t("server.chat.hello", { skills: (yield* agent.skills).length, tools: agent.mcpStatus().toolCount })),
    );
    prompt = () => write("› ");
    prompt();
    yield* typed((typedIn) =>
      Effect.gen(function* () {
        if (typedIn.kind === "interrupt") {
          if (!agent.busy()) {
            yield* Console.log();
            return yield* Quit.make();
          }
          return yield* agent.stop;
        }
        const text = typedIn.text;
        if (text === "/exit") return yield* Quit.make();
        if (text === "/reset") {
          yield* agent.reset;
          yield* Console.log(dim(t("server.chat.forgot")));
          return prompt();
        }
        if (text) {
          const message = yield* said(text);
          yield* agent.send(message);
        } else prompt();
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

interface RuntimeChat {
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
        const registry = registryOf([dshRuntime]);
        const runtime = registry.get(id);
        if (!runtime) return yield* Effect.fail(t("server.chat.noRuntime", { id }));
        const installation = runtime.installation;
        if (!installation) return yield* Effect.fail(t("server.chat.unknownInstall", { id }));
        const found = yield* Effect.tryPromise({ try: () => installation(), catch: messageOf });
        if (found.kind !== "available") return yield* Effect.fail(t("server.chat.unusable", { id, kind: found.kind }));
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
        yield* Console.log(dim(`${id} · ${session.id}${values.resume ? t("server.chat.resumed") : ""}\n` + t("server.chat.direct")));
        session.events(
          (e) => {
            const line = render(e);
            if (line !== undefined) write(line + "\n");
          },
          { cursor: { sessionId: session.id, afterSeq: -1 } },
        );
        const said = (r: unknown, words: "rejected" | "notSent") => {
          const why = Predicate.hasProperty(r, "reason") && typeof r.reason === "string" ? r.reason : "";
          if (Predicate.hasProperty(r, "kind") && r.kind === "rejected") write(dim(t(`server.chat.${words}`, { why })) + "\n");
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
                yield* Console.log();
                return yield* Quit.make();
              }
              return yield* FiberHandle.clear(turns);
            }
            const text = typedIn.text;
            if (text === "/exit") return yield* Quit.make();
            if (!text) return busy ? undefined : write("› ");
            if (!busy) return yield* FiberHandle.run(turns, Effect.ignore(turnOf(text), { log: "Warn" }), { onlyIfMissing: false });
            const steering = session.steer ? session.steer(text) : session.queue(text);
            yield* Effect.tryPromise({ try: () => steering, catch: messageOf }).pipe(
              Effect.map((r) => said(r, "notSent")),
              Effect.ignore({ log: "Warn" }),
            );
          }),
        );
      }).pipe(Effect.scoped);
