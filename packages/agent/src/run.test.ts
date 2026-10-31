import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { type AssistantMessage, type TextContent, type ToolCall, type Usage, zeroUsage } from "@vibevalley/ai/messages";
import { type Answer, answer, assistantMessage, text, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";
import { until } from "@vibevalley/testkit/until";

import { type BrainEvent, type BrainOptions, makeBrain, openBrain, standaloneOwner } from "./brain.ts";
import { applyPlan, planCompaction } from "./compaction.ts";
import { textTool } from "./core/tool.ts";
import { type BrainMessage, messageText, userMessage } from "./messages.ts";
import { RunAccounting, type RunResult } from "./run.ts";
import { appendSession, loadSession } from "./session.ts";
import { answered, lastUser, type Request, scriptedLLM, type Step, systemPrompt, tempHome, withAgent } from "./testing.ts";
import * as engine from "./todo.ts";
import { memoryStore } from "./todoStore.ts";
import { makeTodoRunner } from "./todoTools.ts";

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
const echo = textTool<object>({
  name: "echo",
  description: "",
  parameters: objectSchema(),
  run: () => "ok",
});

/** A bare brain and the receipts of its runs; it closes with the test's scope. */
const receiptAgent = Effect.fnUntraced(function* (steps: readonly Step[], extra: Partial<BrainOptions> = {}) {
  const { llm } = scriptedLLM(steps);
  const dir = home();
  const agent = yield* makeBrain({
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
  yield* Effect.forkScoped(
    Stream.runForEach(yield* agent.events, (e) =>
      Effect.sync(() => {
        if (e.type === "agent_settled") receipts.push(e.run);
      }),
    ),
  );
  return { agent, receipts };
});

describe("a run's receipt", () => {
  it.effect("takes in its tool turns, and each run its own usage", () =>
    Effect.gen(function* () {
      const tool = toolCall("echo", {});
      const { agent, receipts } = yield* receiptAgent(
        [billed([tool], 10, 2, 3), billed([tool], 20, 4, 5), billed("first", 30, 6, 7), billed("second", 40, 8, 9)],
        { tools: [echo] },
      );
      expect(yield* agent.ask(userMessage("one", Date.now()))).toBe("first");
      yield* until(() => receipts.length === 1, "receipts.length === 1");
      expect(receipts[0]).toMatchObject({
        id: 1,
        settled: true,
        usage: { input: 60, output: 12, cacheRead: 15 },
        contextTokens: 43,
      });
      expect(yield* agent.ask(userMessage("two", Date.now()))).toBe("second");
      yield* until(() => receipts.length === 2, "receipts.length === 2");
      expect(receipts[1]).toMatchObject({ id: 2, usage: { input: 40 } });
      expect(agent.progress().lifetime).toMatchObject({ input: 100, output: 20, cacheRead: 24 });
    }),
  );

  it.effect("keeps a failure's words and goes by the last answer", () =>
    Effect.gen(function* () {
      const failed = { stopReason: "error", errorMessage: "broken" } as const;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { agent, receipts } = yield* receiptAgent([billed("failed words", 7, 2, 1, failed), billed("recovered", 3, 1, 0)]);
          expect(yield* agent.ask(userMessage("fail", Date.now()))).toBe("failed words");
          yield* until(() => receipts.length === 1, "receipts.length === 1");
          expect(receipts[0]).toMatchObject({ error: "broken", usage: { input: 7 } });
          yield* agent.ask(userMessage("retry", Date.now()));
          yield* until(() => receipts.length === 2, "receipts.length === 2");
          expect(receipts[1]).toMatchObject({ error: "", usage: { input: 3 } });
        }),
      );
      const accounting = new RunAccounting();
      accounting.begin();
      accounting.message({ ...billedMessage("failed words", 7, 2, 1), ...failed });
      accounting.message(billedMessage("ok", 3, 1, 0));
      expect(accounting.settle(false)).toMatchObject({ error: "", usage: { input: 10 } });
    }),
  );

  it.effect("says nothing for an ask a follow-up took over, when the run ends on tools", () =>
    Effect.gen(function* () {
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      let calls = 0;
      let entered = false;
      const slow = textTool<object>({
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
      const { agent, receipts } = yield* receiptAgent(
        [billed([text("A"), toolCall("echo", {})], 2, 1, 0), billed("A done", 3, 1, 0), billed([toolCall("echo", {})], 4, 1, 0)],
        {
          tools: [slow],
          maxSteps: 3,
        },
      );
      const answer = yield* Effect.forkChild(agent.ask(userMessage("A", Date.now())), { startImmediately: true });
      yield* until(() => entered, "entered");
      yield* agent.later(userMessage("B", Date.now()));
      release();
      expect(yield* Fiber.join(answer)).toBe("");
      yield* until(() => receipts.length === 1, "receipts.length === 1");
      expect(receipts[0]).toMatchObject({ id: 1, text: "", usage: { input: 9 } });
    }),
  );

  it("shows usage from an answer that has only started, and does not count it twice", () => {
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

  it.effect("keeps an answer cut off by closing, with what it used", () =>
    Effect.gen(function* () {
      const { llm } = scriptedLLM([billed("partial", 7, 3, 2, { hangAfter: 7 })]);
      const dir = home();
      const agent = yield* Effect.promise(() =>
        openBrain(standaloneOwner(), {
          name: "partial",
          instructions: "",
          llm,
          home: dir,
          cwd: dir,
          noSkills: true,
          noMemory: true,
          noSubagents: true,
          noSession: true,
          reminders: false,
        }),
      );
      const events: BrainEvent[] = [];
      agent.subscribe((e) => events.push(e));
      void agent.send(userMessage("start", Date.now()));
      yield* until(
        () => events.some((e) => e.type === "message_update" && messageText(e.message) === "partial"),
        'events.some((e) => e.type === "message_update" && messageText(e.message) === "partial")',
      );
      expect(agent.progress().current.settled).toBe(false);
      yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => agent.close())));
      expect(agent.progress()).toMatchObject({
        current: { settled: true, aborted: true },
        lifetime: { input: 7, output: 3, cacheRead: 2 },
      });
      const receipt = events.find((e) => e.type === "agent_settled");
      expect(receipt?.type === "agent_settled" && receipt.run).toMatchObject({
        usage: { input: 7, output: 3 },
        text: "partial",
      });
    }),
  );
});

describe("a compaction", () => {
  it("replays its whole kept tail", async () => {
    const dir = home();
    const messages: BrainMessage[] = [
      userMessage("old", Date.now()),
      assistantMessage("old answer"),
      userMessage("keep", Date.now()),
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
    // oxlint-disable-next-line eslint/no-await-in-loop -- each line after the one before
    for (const m of [...messages, result.summary]) await appendSession(file, m);
    expect(await loadSession(file)).toEqual(JSON.parse(JSON.stringify(result.messages)));
    expect(result.summary.kept).toBe(5);
    expect(result.messages.length).toBe(6);
  });
});

const subagentBrief = (c: Request) => messageText(c.messages[0]!);

describe("the agent's own todos", () => {
  // A and B go out together; C waits for both, then goes; each comes back to the agent as an input.
  it.effect("sends a subagent's tasks when ready, and they come back", () => {
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
      (r) =>
        Effect.gen(function* () {
          yield* r.ask("查三样");
          yield* until(() => sent.length === 3 && told === 3, "sent.length === 3 && told === 3");
          expect(yield* store.load).toEqual([]);
        }),
      { todos: store, reminders: false },
    );
  });

  it.effect("calls the subagents back when the agent is stopped", () => {
    const dir = home();
    const store = memoryStore();
    let started = false;
    const wait = textTool<object>({
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
      (r) =>
        Effect.gen(function* () {
          expect(yield* r.ask("查")).toBe("派好了");
          yield* until(() => started, "started");
          yield* r.agent.stop;
          const g = yield* store.load;
          expect(g[0]).toMatchObject({ state: "waiting" });
          expect(g[0]!.tries ?? 0).toBe(0);
        }),
      { tools: [wait], todos: store, reminders: false },
    );
  });

  // A run that stops with its own todos ready is reminded, at most maxNudges times while the graph stays the same.
  it.effect("reminds a stopped run of its own todos a few times", () =>
    Effect.gen(function* () {
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
      yield* withAgent(
        dir,
        Array.from({ length: 10 }, () => reply),
        (r) =>
          Effect.gen(function* () {
            yield* r.ask("拆一下");
            yield* until(() => nudged >= 2, "nudged >= 2");
            yield* until(() => !r.agent.busy(), "!r.agent.busy()");
            expect(nudged).toBe(2);
            events = [...r.events];
          }),
        { todos: memoryStore(), maxNudges: 2, reminders: false },
      );
      const changed = events.filter((e) => e.type === "todos_changed");
      // The task was one change.
      expect(changed.length).toBe(1);
      expect(changed[0]!.type === "todos_changed" && changed[0]!.todos.length).toBe(2);
    }),
  );

  it.effect("carries the open graph into a fold's summary", () =>
    Effect.gen(function* () {
      const store = memoryStore();
      const summaries = yield* Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* makeTodoRunner(store, undefined, () => Effect.void);
          const before = yield* runner.summary;
          yield* store.change((g) => engine.add(g, [{ id: "a", brief: "读" }])[0]);
          return [before, yield* runner.summary];
        }),
      );
      expect(summaries).toEqual(["", "【整理对话时的任务，以 tasks 为准】\n任务（1 件，1 件可以做）：\n- [可以做] a 读"]);
    }),
  );
});
