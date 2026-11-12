import { afterEach, describe, expect, test } from "vite-plus/test";

import { type AssistantMessage, type TextContent, type ToolCall, type Usage, zeroUsage } from "@vibevalley/ai/messages";
import { type Answer, answer, assistantMessage, text, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";
import { gate, until } from "@vibevalley/testkit/until";

import { type BrainMessage, messageText, userMessage } from "../base/messages.ts";
import { textTool } from "../core/tool.ts";
import { answered, lastUser, type Request, scriptedLLM, type Step, systemPrompt, tempHome, testClock, withAgent } from "../testing/testing.ts";
import * as engine from "../tools/todo.ts";
import { memoryStore } from "../tools/todoStore.ts";
import { makeTodoRunner } from "../tools/todoTools.ts";
import { type BrainEvent, type BrainOptions, makeBrain } from "./brain.ts";
import { applyPlan, planCompaction } from "./compaction.ts";
import { RunAccounting, type RunResult } from "./run.ts";
import { appendSession, loadSession } from "./session.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

type Said = string | readonly (TextContent | ToolCall)[];
const used = (input: number, output: number, cache: number): Usage => ({
  ...zeroUsage(),
  input,
  output,
  cacheRead: cache,
  totalTokens: input + output + cache,
});
const billed = (content: Said, input: number, output: number, cache: number, more: Omit<Answer, "content" | "usage"> = {}): Answer =>
  answer(content, { usage: { input, output, cacheRead: cache }, ...more });
const billedMessage = (content: Said, input: number, output: number, cache: number): AssistantMessage =>
  assistantMessage(content, { usage: used(input, output, cache) });
const echo = textTool({
  name: "echo",
  description: "",
  parameters: objectSchema(),
  run: () => "ok",
});

/** A bare brain and the receipts of its runs; it closes with the test's scope. */
const receiptAgent = async (steps: readonly Step[], extra: Partial<BrainOptions> = {}) => {
  const { llm } = scriptedLLM(steps);
  const dir = home();
  const clock = testClock();
  const agent = await makeBrain({
    clock,
    name: "receipt",
    instructions: "",
    llm,
    home: dir,
    cwd: dir,
    noSkills: true,
    noMemory: true,
    noSubagents: true,
    noSession: true,
    reminders: false,
    ...extra,
  });
  const receipts: RunResult[] = [];
  const events = agent.events();
  const reading = (async () => {
    for await (const e of events) if (e.type === "agent_settled") receipts.push(e.run);
  })();
  return {
    agent,
    receipts,
    clock,
    [Symbol.asyncDispose]: async () => {
      await agent.close();
      await reading;
    },
  };
};

describe("a run's receipt", () => {
  test("takes in its tool turns, and each run its own usage", async () => {
    const tool = toolCall("echo", {});
    await using rig = await receiptAgent([billed([tool], 10, 2, 3), billed([tool], 20, 4, 5), billed("first", 30, 6, 7), billed("second", 40, 8, 9)], {
      tools: [echo],
    });
    const { agent, receipts, clock } = rig;
    const now = clock.now();
    const answer2 = await agent.ask(userMessage("one", now));
    expect(answer2).toBe("first");
    await until(() => receipts.length === 1, "receipts.length === 1");
    expect(receipts[0]).toMatchObject({
      id: 1,
      settled: true,
      usage: { input: 60, output: 12, cacheRead: 15 },
      contextTokens: 43,
    });
    const now2 = clock.now();
    const answer3 = await agent.ask(userMessage("two", now2));
    expect(answer3).toBe("second");
    await until(() => receipts.length === 2, "receipts.length === 2");
    expect(receipts[1]).toMatchObject({ id: 2, usage: { input: 40 } });
    expect(agent.progress().lifetime).toMatchObject({ input: 100, output: 20, cacheRead: 24 });
  });

  test("keeps a failure's words and goes by the last answer", async () => {
    const failed = { stopReason: "error", errorMessage: "broken" } as const;
    await (async () => {
      await using rig = await receiptAgent([billed("failed words", 7, 2, 1, failed), billed("recovered", 3, 1, 0)]);
      const { agent, receipts, clock } = rig;
      const now = clock.now();
      const answer2 = await agent.ask(userMessage("fail", now));
      expect(answer2).toBe("failed words");
      await until(() => receipts.length === 1, "receipts.length === 1");
      expect(receipts[0]).toMatchObject({ error: "broken", usage: { input: 7 } });
      const now2 = clock.now();
      await agent.ask(userMessage("retry", now2));
      await until(() => receipts.length === 2, "receipts.length === 2");
      expect(receipts[1]).toMatchObject({ error: "", usage: { input: 3 } });
    })();
    const accounting = new RunAccounting();
    accounting.begin();
    accounting.message({ ...billedMessage("failed words", 7, 2, 1), ...failed });
    accounting.message(billedMessage("ok", 3, 1, 0));
    expect(accounting.settle(false)).toMatchObject({ error: "", usage: { input: 10 } });
  });

  test("says nothing for an ask a follow-up took over, when the run ends on tools", async () => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    let calls = 0;
    let entered = false;
    const slow = textTool({
      name: "echo",
      description: "",
      parameters: objectSchema(),
      run: async () => {
        if (++calls === 1) {
          entered = true;
          await released;
        }
        return "ok";
      },
    });
    await using rig = await receiptAgent(
      [billed([text("A"), toolCall("echo", {})], 2, 1, 0), billed("A done", 3, 1, 0), billed([toolCall("echo", {})], 4, 1, 0)],
      {
        tools: [slow],
        maxSteps: 3,
      },
    );
    const { agent, receipts, clock } = rig;
    const now = clock.now();
    const answer = agent.ask(userMessage("A", now));
    await until(() => entered, "entered");
    const now2 = clock.now();
    await agent.later(userMessage("B", now2));
    release();
    const answer2 = await answer;
    expect(answer2).toBe("");
    await until(() => receipts.length === 1, "receipts.length === 1");
    expect(receipts[0]).toMatchObject({ id: 1, text: "", usage: { input: 9 } });
  });

  test("shows usage from an answer that has only started, and does not count it twice", () => {
    const accounting = new RunAccounting();
    const message = billedMessage("reported at start", 9, 2, 3);
    accounting.begin();
    accounting.partial(message);
    expect(accounting.snapshot().current).toMatchObject({ usage: { input: 9 }, settled: false });
    accounting.message(message);
    expect(accounting.snapshot()).toMatchObject({
      lifetime: { input: 9 },
      current: { usage: { output: 2 } },
    });
  });

  test("keeps an answer cut off by closing, with what it used", async () => {
    const { llm } = scriptedLLM([billed("partial", 7, 3, 2, { hangAfter: 7 })]);
    const dir = home();
    const clock = testClock();
    const agent = await makeBrain({
      name: "partial",
      instructions: "",
      llm,
      home: dir,
      cwd: dir,
      clock,
      noSkills: true,
      noMemory: true,
      noSubagents: true,
      noSession: true,
      reminders: false,
    });
    const events: BrainEvent[] = [];
    const events2 = agent.events();
    const reader = (async () => {
      for await (const e of events2) events.push(e);
    })();
    const now = clock.now();
    await agent.send(userMessage("start", now));
    await until(
      () => events.some((e) => e.type === "message_update" && messageText(e.message) === "partial"),
      'events.some((e) => e.type === "message_update" && messageText(e.message) === "partial")',
    );
    expect(agent.progress().current.settled).toBe(false);
    await Promise.all(Array.from({ length: 8 }, () => agent.close()));
    await reader;
    expect(agent.progress()).toMatchObject({
      current: { settled: true, aborted: true },
      lifetime: { input: 7, output: 3, cacheRead: 2 },
    });
    const receipt = events.find((e) => e.type === "agent_settled");
    expect(receipt?.type === "agent_settled" && receipt.run).toMatchObject({
      usage: { input: 7, output: 3 },
      text: "partial",
    });
  });
});

describe("a compaction", () => {
  test("replays its whole kept tail", async () => {
    const dir = home();
    const messages: BrainMessage[] = [
      userMessage("old", 1798758000000),
      assistantMessage("old answer"),
      userMessage("keep", 1798758000001),
      assistantMessage("a"),
      assistantMessage("b"),
      assistantMessage("c"),
    ];
    const options = { budget: 1, keepRecent: 2, keepSaid: 0 };
    const initial = planCompaction(messages, options)!;
    const cached = {
      role: "compactionSummary" as const,
      summary: "summary",
      tokensBefore: 0,
      timestamp: 0,
      kept: messages.length - initial.cut,
    };
    messages.push(assistantMessage("late tail"));
    const plan = planCompaction(messages, options)!;
    expect(plan.cut).toBe(initial.cut);
    const result = applyPlan(plan, cached);
    const file = dir + "/session.jsonl";
    // One after another, as the brain writes them.
    for (const m of [...messages, result.summary]) await appendSession(file, m);
    const loaded = await loadSession(file);
    expect(loaded).toEqual(JSON.parse(JSON.stringify(result.messages)));
    expect(result.summary.kept).toBe(5);
    expect(result.messages.length).toBe(6);
  });
});

const subagentBrief = (c: Request) => messageText(c.messages[0]!);

describe("the agent's own todos", () => {
  // A and B go out together. C waits for both, then goes.
  test("sends a subagent's tasks when ready, and they come back", () => {
    const dir = home();
    const store = memoryStore();
    const sent: string[] = [];
    let told = 0;
    const reply = (c: Request): Answer => {
      if (systemPrompt(c).includes("派出去的帮手")) {
        const brief = subagentBrief(c);
        if (brief === "查 C") expect(sent).toEqual(expect.arrayContaining(["查 A", "查 B"]));
        sent.push(brief);
        return answer(brief + " 做完了");
      }
      if (messageText(c.messages.at(-1)!).includes("〔任务〕")) {
        told++;
        return answer("收到");
      }
      if (!answered(c))
        return answer([
          toolCall("todo_add", {
            tasks: [
              { id: "a", brief: "查 A", by: "subagent" },
              { id: "b", brief: "查 B", by: "subagent" },
              { id: "c", brief: "查 C", by: "subagent", after: ["a", "b"] },
            ],
          }),
        ]);
      return answer("派好了");
    };
    return withAgent(
      dir,
      Array.from({ length: 12 }, () => reply),
      async (r) => {
        await r.ask("查三样");
        await until(() => sent.length === 3 && told === 3, "sent.length === 3 && told === 3");
        const loaded = await store.load();
        expect(loaded).toEqual([]);
      },
      { todos: store, reminders: false },
    );
  });

  test("calls the subagents back when the agent is stopped", () => {
    const dir = home();
    const store = memoryStore();
    let started = false;
    const wait = textTool({
      name: "wait",
      description: "等",
      parameters: objectSchema(),
      run: (_, tc) =>
        new Promise((_, reject) => {
          started = true;
          tc.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const reply = (c: Request): Answer => {
      if (systemPrompt(c).includes("派出去的帮手")) return answer([toolCall("wait", {})]);
      if (!answered(c)) return answer([toolCall("todo_add", { tasks: [{ id: "a", brief: "查 A", by: "subagent" }] })]);
      return answer("派好了");
    };
    return withAgent(
      dir,
      Array.from({ length: 4 }, () => reply),
      async (r) => {
        const answer2 = await r.ask("查");
        expect(answer2).toBe("派好了");
        await until(() => started, "started");
        await r.agent.stop();
        const g = await store.load();
        expect(g[0]).toMatchObject({ state: "waiting" });
        expect(g[0]!.tries ?? 0).toBe(0);
      },
      { tools: [wait], todos: store, reminders: false },
    );
  });

  // A run that stops with its own todos ready is reminded, at most maxNudges times while the graph stays the same.
  test("reminds a stopped run of its own todos a few times", async () => {
    const dir = home();
    let nudged = 0;
    const reply = (c: Request): Answer => {
      if (lastUser(c).includes("这一轮停了，还有 2 件你可以做：a、b")) {
        nudged++;
        return answer("还没空");
      }
      if (!answered(c))
        return answer([
          toolCall("todo_add", {
            tasks: [
              { id: "a", brief: "读" },
              { id: "b", brief: "写" },
            ],
          }),
        ]);
      return answer("先这样");
    };
    let events: BrainEvent[] = [];
    await withAgent(
      dir,
      Array.from({ length: 10 }, () => reply),
      async (r) => {
        await r.ask("拆一下");
        await until(() => nudged >= 2, "nudged >= 2");
        await until(() => !r.agent.busy(), "!r.agent.busy()");
        expect(nudged).toBe(2);
        events = [...r.events];
      },
      { todos: memoryStore(), maxNudges: 2, reminders: false },
    );
    const changed = events.filter((e) => e.type === "todos_changed");
    // The task was one change.
    expect(changed.length).toBe(1);
    expect(changed[0]!.type === "todos_changed" && changed[0]!.todos.length).toBe(2);
  });

  test("the fixture consumes its settled run without waiting for an already-started nudge", async () => {
    const clock = testClock(1798758000000);
    const release = gate();
    let entered = false;
    let returned = false;
    await withAgent(
      home(),
      [
        answer([toolCall("todo_add", { tasks: [{ id: "a", brief: "read" }] })]),
        answer("first settled"),
        () => {
          entered = true;
          return release.opened.then(() => answer("nudge settled"));
        },
      ],
      async (r) => {
        try {
          const asking = r.ask("start").then((said) => {
            returned = true;
            return said;
          });
          await until(() => entered, "the next nudge has entered its model request");
          await until(() => returned, "the fixture consumed the first run while the nudge is held");
          const asking2 = await asking;
          expect(asking2).toBe("first settled");
          expect(r.agent.progress().current).toMatchObject({ id: 2, settled: false });
          expect(r.events.filter((e) => e.type === "agent_settled").map((e) => e.run.id)).toEqual([1]);
          release.open();
          await until(() => r.events.some((e) => e.type === "agent_settled" && e.run.id === 2), "the released nudge settles");
        } finally {
          release.open();
        }
      },
      { todos: memoryStore(), maxNudges: 1, reminders: false, clock },
    );
  });

  test("carries the open graph into a fold's summary", async () => {
    const store = memoryStore();
    const runner = makeTodoRunner(store, undefined, async () => undefined);
    const before = await runner.summary();
    await store.change((g) => engine.add(g, [{ id: "a", brief: "读" }])[0]);
    const summaries = [before, await runner.summary()];
    await runner.close();
    expect(summaries).toEqual(["", "【整理对话时的任务，以 tasks 为准】\n任务（1 件，1 件可以做）：\n- [可以做] a 读"]);
  });
});
