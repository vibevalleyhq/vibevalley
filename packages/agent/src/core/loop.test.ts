import { describe, expect, test } from "vite-plus/test";

import { makeLlm } from "@vibevalley/ai/llm";
import type { Context, Message, ToolResultMessage, UserMessage } from "@vibevalley/ai/messages";
import { answer, chunk, http, type Request, scriptedLlm, type Step, testModel, text, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";

import { AgentBusy } from "./errors.ts";
import { type AgentEvent, type AgentOptions, make, type Tool } from "./loop.ts";

const user = (t: string): UserMessage => ({ role: "user", content: t, timestamp: 1 });
type Gate = PromiseWithResolvers<void>;
const deferred = (): Gate => Promise.withResolvers<void>();
const done = (t: string): Tool => ({ name: t, description: "", parameters: objectSchema(), execute: async () => ({ content: [text(t)] }) });
/** A tool that says it started and works until let go. */
const held = (name: string, started: Gate, release: Gate, said = name): Tool => ({
  name,
  description: "",
  parameters: objectSchema(),
  execute: async () => {
    started.resolve();
    await release.promise;
    return { content: [text(said)] };
  },
});
const readFile: Tool = {
  name: "read_file",
  description: "",
  parameters: objectSchema({ path: { type: "string" } }, "path"),
  execute: async () => ({ content: [text("读了")] }),
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
    .filter((e, i, all) => !(e.startsWith("message_update") && all[i - 1]?.startsWith("message_update") === true));

/** streaming is done once the answer's text is said. */
const rig = (
  steps: readonly Step[],
  tools: readonly Tool[],
  more: Partial<AgentOptions<never>> = {},
  hook: (e: AgentEvent<never>) => void | Promise<void> = () => undefined,
  said = "",
) => {
  const { llm, requests } = scriptedLlm(steps);
  const events: AgentEvent<never>[] = [];
  const streaming = deferred();
  const agent = make<never>({
    llm,
    model: testModel,
    tools,
    messages: [],
    apiKey: () => "k",
    toLlm: (messages): Context => ({ system: "", tools: [], messages: messages }),
    onEvent: async (e) => {
      events.push(e);
      if (e.type === "message_update" && words(e.message) === "assistant:" + said) streaming.resolve();
      await hook(e);
    },
    stoppedText: "已停下",
    ...more,
  });
  return { agent, events, requests, streaming: streaming.promise, said: () => agent.messages().map(words) };
};

describe("an agent's loop", () => {
  test("goes through its events in one order", async () => {
    const r = rig([answer([toolCall("list_dir", {})]), answer("好了")], [done("list_dir")]);
    await r.agent.prompt([user("列一下")]);
    await r.agent.idle();
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
  });

  test("runs no tool call of an answer cut off at its length, and says why", async () => {
    let ran = 0;
    const counted: Tool = { ...done("counted"), execute: async () => ({ content: [text(String(++ran))] }) };
    const r = rig([answer([toolCall("counted", {})], { stopReason: "length" }), answer("再来")], [counted]);
    await r.agent.prompt([user("数")]);
    await r.agent.idle();
    expect(ran).toBe(0);
    expect(results(r.requests[1]!)).toEqual([
      {
        failed: true,
        text: 'Tool call "counted" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
      },
    ]);
  });

  test("answers a tool that is not there, and arguments a tool refuses, as failed calls", async () => {
    const r = rig([answer([toolCall("no_such_tool", {}), toolCall("read_file", { path: ["a"] })]), answer("知道了")], [readFile]);
    await r.agent.prompt([user("试试")]);
    await r.agent.idle();
    expect(results(r.requests[1]!)).toEqual([
      { failed: true, text: "Tool no_such_tool not found" },
      { failed: true, text: 'Validation failed for tool "read_file":\n  - path: must be string\n\nReceived arguments:\n{\n  "path": [\n    "a"\n  ]\n}' },
    ]);
  });

  test("takes every line waiting at a step boundary in one turn, and a follow-up only when it would stop", async () => {
    const [napping, wake] = [deferred(), deferred()];
    const r = rig(
      [answer([toolCall("nap", {})]), (q) => answer("听到" + lastUser(q)), (q) => answer("听到" + lastUser(q))],
      [held("nap", napping, wake, "醒了")],
    );
    await r.agent.prompt([user("开始")]);
    await napping.promise;
    await r.agent.followUp(user("完了再说"));
    await r.agent.steer(user("甲"));
    await r.agent.steer(user("乙"));
    wake.resolve();
    await r.agent.idle();
    const said2 = r.said();
    expect(said2).toEqual([
      "user:开始",
      "assistant:",
      "toolResult:醒了",
      "user:甲",
      "user:乙",
      "assistant:听到user:乙",
      "user:完了再说",
      "assistant:听到user:完了再说",
    ]);
    expect(r.requests).toHaveLength(3);
    expect(r.requests[1]!.messages.filter((m) => m.role === "user").map(words)).toEqual(["user:开始", "user:甲", "user:乙"]);
  });

  test("runs the tools of one answer side by side, and keeps their results in the order they were called", async () => {
    const [slowStarted, slowDone] = [deferred(), deferred()];
    const r = rig(
      [answer([text("两个"), toolCall("slow", {}), toolCall("fast", {})]), answer("都好了")],
      [held("slow", slowStarted, slowDone, "慢的"), done("fast")],
      {},
      (e) => {
        if (e.type === "tool_execution_end" && e.toolName === "fast") slowDone.resolve();
      },
    );
    await r.agent.prompt([user("一起")]);
    await r.agent.idle();
    expect(r.events.flatMap((e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end" ? [e.type + ":" + e.toolName] : []))).toEqual([
      "tool_execution_start:slow",
      "tool_execution_start:fast",
      "tool_execution_end:fast",
      "tool_execution_end:slow",
    ]);
    const said2 = r.said();
    expect(said2).toEqual(["user:一起", "assistant:两个", "toolResult:慢的", "toolResult:fast", "assistant:都好了"]);
  });

  test("caps how many tools run at once in one turn, and still keeps their results in call order", async () => {
    let inFlight = 0;
    let peak = 0;
    const firstWave = deferred();
    const releaseFirst = deferred();
    const gated = (name: string, hold: boolean): Tool => ({
      name,
      description: "",
      parameters: objectSchema(),
      execute: async () => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        if (inFlight === 2) firstWave.resolve();
        if (hold) await releaseFirst.promise;
        inFlight -= 1;
        return { content: [text(name)] };
      },
    });
    const r = rig(
      [answer([toolCall("t1", {}), toolCall("t2", {}), toolCall("t3", {}), toolCall("t4", {})]), answer("齐了")],
      [gated("t1", true), gated("t2", true), gated("t3", false), gated("t4", false)],
      { toolConcurrency: 2 },
    );
    await r.agent.prompt([user("四个")]);
    await firstWave.promise;
    expect(peak).toBe(2);
    releaseFirst.resolve();
    await r.agent.idle();
    expect(peak).toBe(2);
    const said2 = r.said();
    expect(said2).toEqual(["user:四个", "assistant:", "toolResult:t1", "toolResult:t2", "toolResult:t3", "toolResult:t4", "assistant:齐了"]);
  });

  test("stopped while the model answers, keeps what had come, aborted", async () => {
    const r = rig([answer("说到一半就停", { hangAfter: 3 })], [], {}, undefined, "说到一");
    await r.agent.prompt([user("说")]);
    await r.streaming;
    await r.agent.abort();
    await r.agent.idle();
    const last = r.agent.messages().at(-1)!;
    expect(last.role === "assistant" && [last.stopReason, last.errorMessage, words(last)]).toEqual(["aborted", "Request was aborted", "assistant:说到一"]);
    expect(r.events.slice(-2).map((e) => e.type)).toEqual(["turn_end", "agent_end"]);
  });

  test("stopped while the answer comes over the wire, the request is cut off and what had come is kept", async () => {
    let wrote = false;
    const hanging = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (wrote) return new Promise(() => {});
        wrote = true;
        controller.enqueue(new TextEncoder().encode(chunk({ content: "说到" })));
        return undefined;
      },
    });
    const r = rig([], [], { llm: makeLlm({ fetch: http([], hanging) }) }, undefined, "说到");
    await r.agent.prompt([user("说")]);
    await r.streaming;
    await r.agent.abort();
    await r.agent.idle();
    const last = r.agent.messages().at(-1)!;
    expect(last.role === "assistant" && [last.stopReason, last.errorMessage, words(last)]).toEqual(["aborted", "Request was aborted", "assistant:说到"]);
  });

  test("ends a request the model refused with its status as the error", async () => {
    const r = rig([], [], { llm: makeLlm({ fetch: http([], "nope", 500) }) });
    await r.agent.prompt([user("问")]);
    await r.agent.idle();
    const last = r.agent.messages().at(-1)!;
    expect(last.role === "assistant" && [last.stopReason, last.errorMessage]).toEqual(["error", "500 nope"]);
  });

  test("does not start a call once the run is stopped", async () => {
    let ran = 0;
    const counted: Tool = { ...done("counted"), execute: async () => ({ content: [text(String(++ran))] }) };
    let stop: () => Promise<void> = async () => undefined;
    const r = rig(
      [answer([toolCall("counted", {}, "c1"), toolCall("counted", {}, "c2")])],
      [counted],
      { finishTurn: (turn) => (turn.stopped ? "end" : undefined) },
      (e) => (e.type === "tool_execution_start" && e.toolCallId === "c1" ? stop() : undefined),
    );
    stop = r.agent.abort;
    await r.agent.prompt([user("数")]);
    await r.agent.idle();
    expect(ran).toBe(0);
    const said2 = r.said();
    expect(said2).toEqual(["user:数", "assistant:", "toolResult:Operation aborted"]);
  });

  test("stopped while a tool works, the tool says so and the turn ends there", async () => {
    const [started, never] = [deferred(), deferred()];
    const r = rig([answer([toolCall("sleep", {})])], [held("sleep", started, never)], {
      finishTurn: (turn) => (turn.stopped ? "end" : undefined),
    });
    await r.agent.prompt([user("睡")]);
    await started.promise;
    await r.agent.abort();
    await r.agent.idle();
    const said2 = r.said();
    expect(said2).toEqual(["user:睡", "assistant:", "toolResult:已停下"]);
    expect(r.requests.length).toBe(1);
  });

  test("ends the run at a model's error, the error kept", async () => {
    const r = rig([answer("", { stopReason: "error", errorMessage: "429: busy" })], []);
    await r.agent.prompt([user("问")]);
    await r.agent.idle();
    const last = r.agent.messages().at(-1)!;
    expect(last.role === "assistant" && [last.stopReason, last.errorMessage]).toEqual(["error", "429: busy"]);
    expect(r.events.slice(-2).map((e) => e.type)).toEqual(["turn_end", "agent_end"]);
  });

  test("asks with what prepareRequest gives, for the rest of the run", async () => {
    const r = rig([answer([toolCall("list_dir", {})]), answer("好")], [done("list_dir")], {
      prepareRequest: async (asked) => (asked[0]?.role === "user" && asked.length > 1 ? undefined : [user("摘要"), ...asked.slice(1)]),
    });
    await r.agent.prompt([user("原话")]);
    await r.agent.idle();
    expect(r.requests.map((q) => q.messages.map(words))).toEqual([["user:摘要"], ["user:摘要", "assistant:", "toolResult:list_dir"]]);
  });

  test("stopped while preparing a request, stops preparing it, and the request ends aborted", async () => {
    const [preparing, interrupted] = [deferred(), deferred()];
    const r = rig([answer("不该有")], [], {
      prepareRequest: (_asked, _stopped, signal) => {
        preparing.resolve();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            interrupted.resolve();
            reject(signal.reason);
          }),
        );
      },
    });
    await r.agent.prompt([user("说")]);
    await preparing.promise;
    await r.agent.abort();
    await r.agent.idle();
    let isDone2 = false;
    void interrupted.promise.then(() => (isDone2 = true));
    await Promise.resolve();
    expect(isDone2).toBe(true);
    const last = r.agent.messages().at(-1)!;
    expect(last.role === "assistant" && [last.stopReason, words(last)]).toEqual(["aborted", "assistant:"]);
  });

  test("refuses a second run while one is under way", async () => {
    const [started, release] = [deferred(), deferred()];
    const r = rig([answer([toolCall("wait", {})]), answer("好")], [held("wait", started, release)]);
    await r.agent.prompt([user("一")]);
    await started.promise;
    const promptFailure = await r.agent.prompt([user("二")]).catch((e: unknown) => e);
    expect(promptFailure).toBeInstanceOf(AgentBusy);
    release.resolve();
    await r.agent.idle();
  });
});
