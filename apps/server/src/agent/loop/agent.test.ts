import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import type { Context, Message, ToolResultMessage, UserMessage } from "../../ai/messages.ts";
import { make as llmOver } from "../../ai/llm.ts";
import { answer, chunk, http, type Request, scriptedLlm, type Step, testModel, text, toolCall } from "../../ai/testing.ts";
import { objectSchema } from "../../ai/tools.ts";
import { type AgentEvent, type AgentOptions, AgentBusy, make, type Tool } from "./agent.ts";

const user = (t: string): UserMessage => ({ role: "user", content: t, timestamp: 1 });
const done = (t: string): Tool => ({ name: t, description: "", parameters: objectSchema(), execute: () => Effect.succeed({ content: [text(t)] }) });
/** A tool that says it started and works until let go. */
const held = (name: string, started: Deferred.Deferred<void>, release: Deferred.Deferred<void>, said = name): Tool => ({
  name,
  description: "",
  parameters: objectSchema(),
  execute: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.as(Deferred.await(release), { content: [text(said)] })),
});
const readFile: Tool = {
  name: "read_file",
  description: "",
  parameters: objectSchema({ path: { type: "string" } }, "path"),
  execute: () => Effect.succeed({ content: [text("读了")] }),
};

const words = (m: Message | { role: string }) => {
  if (!("content" in m)) return m.role;
  const c = m.content;
  return m.role + ":" + (typeof c === "string" ? c : c.map((b) => ("text" in b ? b.text : "")).join(""));
};
const results = (r: Request) =>
  r.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => ({ failed: m.isError, text: words(m).slice("toolResult:".length) }));
const lastUser = (r: Request) => words(r.messages.findLast((m) => m.role === "user")!);
const shape = (events: readonly AgentEvent<never>[]) =>
  events
    .map((e) => ("message" in e && e.type.startsWith("message_") ? `${e.type}:${e.message.role}` : "toolName" in e ? `${e.type}:${e.toolName}` : e.type))
    .filter((e, i, all) => !(e.startsWith("message_update") && all[i - 1]?.startsWith("message_update")));

/** streaming is done once the answer's text is said. */
const rig = (
  steps: readonly Step[],
  tools: readonly Tool[],
  more: Partial<AgentOptions<never>> = {},
  hook: (e: AgentEvent<never>) => Effect.Effect<void> = () => Effect.void,
  said = "",
) =>
  Effect.gen(function* () {
    const { llm, requests } = yield* scriptedLlm(steps);
    const events: AgentEvent<never>[] = [];
    const streaming = yield* Deferred.make<void>();
    const agent = yield* make<never>({
      llm,
      model: testModel,
      tools,
      messages: [],
      apiKey: () => "k",
      toLlm: (messages): Context => ({ system: "", tools: [], messages: messages }),
      onEvent: (e) =>
        Effect.andThen(
          Effect.sync(() => events.push(e)),
          Effect.andThen(
            e.type === "message_update" && words(e.message) === "assistant:" + said ? Deferred.succeed(streaming, undefined) : Effect.void,
            hook(e),
          ),
        ),
      stoppedText: "已停下",
      ...more,
    });
    return { agent, events, requests, streaming, said: Effect.map(Ref.get(agent.messages), (all) => all.map(words)) };
  });

describe("an agent's loop", () => {
  it.effect("goes through its events in one order", () =>
    Effect.gen(function* () {
      const r = yield* rig([answer([toolCall("list_dir", {})]), answer("好了")], [done("list_dir")]);
      yield* r.agent.prompt([user("列一下")]);
      yield* r.agent.idle;
      expect(shape(r.events)).toEqual([
        "agent_start",
        "turn_start",
        "message_start:user",
        "message_end:user",
        "message_start:assistant",
        "message_update:assistant",
        "message_end:assistant",
        "tool_execution_start:list_dir",
        "tool_execution_end:list_dir",
        "message_start:toolResult",
        "message_end:toolResult",
        "turn_end",
        "turn_start",
        "message_start:assistant",
        "message_update:assistant",
        "message_end:assistant",
        "turn_end",
        "agent_end",
      ]);
    }),
  );

  it.effect("runs no tool call of an answer cut off at its length, and says why", () =>
    Effect.gen(function* () {
      let ran = 0;
      const counted: Tool = { ...done("counted"), execute: () => Effect.sync(() => ({ content: [text(String(++ran))] })) };
      const r = yield* rig([answer([toolCall("counted", {})], { stopReason: "length" }), answer("再来")], [counted]);
      yield* r.agent.prompt([user("数")]);
      yield* r.agent.idle;
      expect(ran).toBe(0);
      expect(results(r.requests[1]!)).toEqual([
        {
          failed: true,
          text: 'Tool call "counted" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
        },
      ]);
    }),
  );

  it.effect("answers a tool that is not there, and arguments a tool refuses, as failed calls", () =>
    Effect.gen(function* () {
      const r = yield* rig([answer([toolCall("no_such_tool", {}), toolCall("read_file", { path: ["a"] })]), answer("知道了")], [readFile]);
      yield* r.agent.prompt([user("试试")]);
      yield* r.agent.idle;
      expect(results(r.requests[1]!)).toEqual([
        { failed: true, text: "Tool no_such_tool not found" },
        { failed: true, text: 'Validation failed for tool "read_file":\n  - path: must be string\n\nReceived arguments:\n{\n  "path": [\n    "a"\n  ]\n}' },
      ]);
    }),
  );

  it.effect("takes the lines sent while it works one a turn, and a follow-up only when it would stop", () =>
    Effect.gen(function* () {
      const [napping, wake] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const r = yield* rig(
        [answer([toolCall("nap", {})]), (q) => answer("听到" + lastUser(q)), (q) => answer("听到" + lastUser(q)), (q) => answer("听到" + lastUser(q))],
        [held("nap", napping, wake, "醒了")],
      );
      yield* r.agent.prompt([user("开始")]);
      yield* Deferred.await(napping);
      yield* r.agent.followUp(user("完了再说"));
      yield* r.agent.steer(user("甲"));
      yield* r.agent.steer(user("乙"));
      yield* Deferred.succeed(wake, undefined);
      yield* r.agent.idle;
      expect(yield* r.said).toEqual([
        "user:开始",
        "assistant:",
        "toolResult:醒了",
        "user:甲",
        "assistant:听到user:甲",
        "user:乙",
        "assistant:听到user:乙",
        "user:完了再说",
        "assistant:听到user:完了再说",
      ]);
    }),
  );

  it.effect("runs the tools of one answer side by side, and keeps their results in the order they were called", () =>
    Effect.gen(function* () {
      const [slowStarted, slowDone] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const r = yield* rig(
        [answer([text("两个"), toolCall("slow", {}), toolCall("fast", {})]), answer("都好了")],
        [held("slow", slowStarted, slowDone, "慢的"), done("fast")],
        {},
        (e) => (e.type === "tool_execution_end" && e.toolName === "fast" ? Deferred.succeed(slowDone, undefined) : Effect.void),
      );
      yield* r.agent.prompt([user("一起")]);
      yield* r.agent.idle;
      expect(r.events.flatMap((e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end" ? [e.type + ":" + e.toolName] : []))).toEqual([
        "tool_execution_start:slow",
        "tool_execution_start:fast",
        "tool_execution_end:fast",
        "tool_execution_end:slow",
      ]);
      expect(yield* r.said).toEqual(["user:一起", "assistant:两个", "toolResult:慢的", "toolResult:fast", "assistant:都好了"]);
    }),
  );

  it.effect("stopped while the model answers, keeps what had come, aborted", () =>
    Effect.gen(function* () {
      const r = yield* rig([answer("说到一半就停", { hangAfter: 3 })], [], {}, undefined, "说到一");
      yield* r.agent.prompt([user("说")]);
      yield* Deferred.await(r.streaming);
      yield* r.agent.abort;
      yield* r.agent.idle;
      const last = (yield* Ref.get(r.agent.messages)).at(-1)!;
      expect(last.role === "assistant" && [last.stopReason, last.errorMessage, words(last)]).toEqual(["aborted", "Request was aborted", "assistant:说到一"]);
      expect(r.events.slice(-2).map((e) => e.type)).toEqual(["turn_end", "agent_end"]);
    }),
  );

  it.effect("stopped while the answer comes over the wire, the request is cut off and what had come is kept", () =>
    Effect.gen(function* () {
      let wrote = false;
      const hanging = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (wrote) return new Promise(() => {});
          wrote = true;
          controller.enqueue(new TextEncoder().encode(chunk({ content: "说到" })));
          return undefined;
        },
      });
      const r = yield* rig([], [], { llm: yield* llmOver.pipe(Effect.provide(http([], hanging))) }, undefined, "说到");
      yield* r.agent.prompt([user("说")]);
      yield* Deferred.await(r.streaming);
      yield* r.agent.abort;
      yield* r.agent.idle;
      const last = (yield* Ref.get(r.agent.messages)).at(-1)!;
      expect(last.role === "assistant" && [last.stopReason, last.errorMessage, words(last)]).toEqual(["aborted", "Request was aborted", "assistant:说到"]);
    }),
  );

  it.effect("ends a request the model refused with its status as the error", () =>
    Effect.gen(function* () {
      const r = yield* rig([], [], { llm: yield* llmOver.pipe(Effect.provide(http([], "nope", 500))) });
      yield* r.agent.prompt([user("问")]);
      yield* r.agent.idle;
      const last = (yield* Ref.get(r.agent.messages)).at(-1)!;
      expect(last.role === "assistant" && [last.stopReason, last.errorMessage]).toEqual(["error", "500 nope"]);
    }),
  );

  it.effect("does not start a call once the run is stopped", () =>
    Effect.gen(function* () {
      let ran = 0;
      const counted: Tool = { ...done("counted"), execute: () => Effect.sync(() => ({ content: [text(String(++ran))] })) };
      let stop: Effect.Effect<void> = Effect.void;
      const r = yield* rig(
        [answer([toolCall("counted", {}, "c1"), toolCall("counted", {}, "c2")])],
        [counted],
        { finishTurn: (turn) => Effect.succeed(turn.stopped ? "end" : undefined) },
        (e) => (e.type === "tool_execution_start" && e.toolCallId === "c1" ? Effect.suspend(() => stop) : Effect.void),
      );
      stop = r.agent.abort;
      yield* r.agent.prompt([user("数")]);
      yield* r.agent.idle;
      expect(ran).toBe(0);
      expect(yield* r.said).toEqual(["user:数", "assistant:", "toolResult:Operation aborted"]);
    }),
  );

  it.effect("stopped while a tool works, the tool says so and the turn ends there", () =>
    Effect.gen(function* () {
      const [started, never] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const r = yield* rig([answer([toolCall("sleep", {})])], [held("sleep", started, never)], {
        finishTurn: (turn) => Effect.succeed(turn.stopped ? "end" : undefined),
      });
      yield* r.agent.prompt([user("睡")]);
      yield* Deferred.await(started);
      yield* r.agent.abort;
      yield* r.agent.idle;
      expect(yield* r.said).toEqual(["user:睡", "assistant:", "toolResult:已停下"]);
      expect(r.requests.length).toBe(1);
    }),
  );

  it.effect("ends the run at a model's error, the error kept", () =>
    Effect.gen(function* () {
      const r = yield* rig([answer("", { stopReason: "error", errorMessage: "429: busy" })], []);
      yield* r.agent.prompt([user("问")]);
      yield* r.agent.idle;
      const last = (yield* Ref.get(r.agent.messages)).at(-1)!;
      expect(last.role === "assistant" && [last.stopReason, last.errorMessage]).toEqual(["error", "429: busy"]);
      expect(r.events.slice(-2).map((e) => e.type)).toEqual(["turn_end", "agent_end"]);
    }),
  );

  it.effect("asks with what prepareRequest gives, for the rest of the run", () =>
    Effect.gen(function* () {
      const r = yield* rig([answer([toolCall("list_dir", {})]), answer("好")], [done("list_dir")], {
        prepareRequest: (asked) => Effect.succeed(asked[0]?.role === "user" && asked.length > 1 ? undefined : [user("摘要"), ...asked.slice(1)]),
      });
      yield* r.agent.prompt([user("原话")]);
      yield* r.agent.idle;
      expect(r.requests.map((q) => q.messages.map(words))).toEqual([["user:摘要"], ["user:摘要", "assistant:", "toolResult:list_dir"]]);
    }),
  );

  it.effect("stopped while preparing a request, stops preparing it, and the request ends aborted", () =>
    Effect.gen(function* () {
      const [preparing, interrupted] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const r = yield* rig([answer("不该有")], [], {
        prepareRequest: () =>
          Effect.andThen(
            Deferred.succeed(preparing, undefined),
            Effect.onInterrupt(Effect.never, () => Deferred.succeed(interrupted, undefined)),
          ),
      });
      yield* r.agent.prompt([user("说")]);
      yield* Deferred.await(preparing);
      yield* r.agent.abort;
      yield* r.agent.idle;
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      const last = (yield* Ref.get(r.agent.messages)).at(-1)!;
      expect(last.role === "assistant" && [last.stopReason, words(last)]).toEqual(["aborted", "assistant:"]);
    }),
  );

  it.effect("refuses a second run while one is under way", () =>
    Effect.gen(function* () {
      const [started, release] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const r = yield* rig([answer([toolCall("wait", {})]), answer("好")], [held("wait", started, release)]);
      yield* r.agent.prompt([user("一")]);
      yield* Deferred.await(started);
      expect(yield* Effect.flip(r.agent.prompt([user("二")]))).toBeInstanceOf(AgentBusy);
      yield* Deferred.succeed(release, undefined);
      yield* r.agent.idle;
    }),
  );
});
