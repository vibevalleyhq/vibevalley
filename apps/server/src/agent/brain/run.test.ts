import { type AssistantMessage, type TextContent, type ToolCall, type Usage, zeroUsage } from "../../ai/messages.ts";
import { type Answer, answer, assistantMessage, text, toolCall } from "../../ai/testing.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as engine from "./agentTask.ts";
import { memoryStore } from "./agentTaskStore.ts";
import { type BrainEvent, type BrainOptions, openBrain, standaloneOwner } from "./agent.ts";
import { applyPlan, planCompaction } from "./compaction.ts";
import { type BrainMessage, messageText, userMessage } from "./messages.ts";
import { RunAccounting, type RunResult } from "./run.ts";
import { SessionFile } from "./session.ts";
import { makeTaskRunner } from "./agentTaskTools.ts";
import { answered, lastUser, type Request, scriptedLLM, type Step, systemPrompt, tempHome, until, withAgent } from "./testing.ts";
import { textTool } from "./tool.ts";
import { objectSchema } from "../../ai/tools.ts";
import { wallTime } from "../../base/time.ts";

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

async function receiptAgent(steps: readonly Step[], extra: Partial<BrainOptions> = {}) {
  const { llm } = scriptedLLM(steps);
  const dir = home();
  const agent = await openBrain(standaloneOwner(), {
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
  agent.subscribe((e) => {
    if (e.type === "agent_settled") receipts.push(e.run);
  });
  return { agent, receipts };
}

describe("a run's receipt", () => {
  it("takes in its tool turns, and each run its own usage", async () => {
    const tool = toolCall("echo", {});
    const { agent, receipts } = await receiptAgent(
      [billed([tool], 10, 2, 3), billed([tool], 20, 4, 5), billed("first", 30, 6, 7), billed("second", 40, 8, 9)],
      { tools: [echo] },
    );
    expect(await agent.ask(userMessage("one", wallTime.now()))).toBe("first");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({
      id: 1,
      settled: true,
      usage: { input: 60, output: 12, cacheRead: 15 },
      contextTokens: 43,
    });
    expect(await agent.ask(userMessage("two", wallTime.now()))).toBe("second");
    await until(() => receipts.length === 2);
    expect(receipts[1]).toMatchObject({ id: 2, usage: { input: 40 } });
    expect(agent.progress().lifetime).toMatchObject({ input: 100, output: 20, cacheRead: 24 });
    await agent.close();
  });

  it("keeps a failure's words and goes by the last answer", async () => {
    const failed = { stopReason: "error", errorMessage: "broken" } as const;
    const { agent, receipts } = await receiptAgent([billed("failed words", 7, 2, 1, failed), billed("recovered", 3, 1, 0)]);
    expect(await agent.ask(userMessage("fail", wallTime.now()))).toBe("failed words");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ error: "broken", usage: { input: 7 } });
    await agent.ask(userMessage("retry", wallTime.now()));
    await until(() => receipts.length === 2);
    expect(receipts[1]).toMatchObject({ error: "", usage: { input: 3 } });
    await agent.close();
    const accounting = new RunAccounting();
    accounting.begin();
    accounting.message({ ...billedMessage("failed words", 7, 2, 1), ...failed });
    accounting.message(billedMessage("ok", 3, 1, 0));
    expect(accounting.settle(false)).toMatchObject({ error: "", usage: { input: 10 } });
  });

  it("says nothing for an ask a follow-up took over, when the run ends on tools", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
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
    const { agent, receipts } = await receiptAgent(
      [billed([text("A"), toolCall("echo", {})], 2, 1, 0), billed("A done", 3, 1, 0), billed([toolCall("echo", {})], 4, 1, 0)],
      {
        tools: [slow],
        maxSteps: 3,
      },
    );
    const answer = agent.ask(userMessage("A", wallTime.now()));
    await until(() => entered);
    await agent.later(userMessage("B", wallTime.now()));
    release();
    expect(await answer).toBe("");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ id: 1, text: "", usage: { input: 9 } });
    await agent.close();
  });

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

  it("keeps an answer cut off by closing, with what it used", async () => {
    const { llm } = scriptedLLM([billed("partial", 7, 3, 2, { hangAfter: 7 })]);
    const dir = home();
    const agent = await openBrain(standaloneOwner(), {
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
    });
    const events: BrainEvent[] = [];
    agent.subscribe((e) => events.push(e));
    void agent.send(userMessage("start", wallTime.now()));
    await until(() => events.some((e) => e.type === "message_update" && messageText(e.message) === "partial"));
    expect(agent.progress().current.settled).toBe(false);
    await Promise.all(Array.from({ length: 8 }, () => agent.close()));
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
  it("replays its whole kept tail", () => {
    const dir = home();
    const messages: BrainMessage[] = [
      userMessage("old", wallTime.now()),
      assistantMessage("old answer"),
      userMessage("keep", wallTime.now()),
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
    const session = new SessionFile(dir + "/session.jsonl");
    for (const m of messages) session.append(m);
    session.append(result.summary);
    expect(session.load()).toEqual(JSON.parse(JSON.stringify(result.messages)));
    expect(result.summary.kept).toBe(5);
    expect(result.messages.length).toBe(6);
  });
});

const subagentBrief = (c: Request) => messageText(c.messages[0]!);

describe("the agent's own tasks", () => {
  // A and B go out together; C waits for both, then goes; each comes back to the agent as an input.
  it("sends a subagent's tasks when ready, and they come back", async () => {
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
          toolCall("task_add", {
            tasks: [
              { id: "a", brief: "查 A", by: "subagent" },
              { id: "b", brief: "查 B", by: "subagent" },
              { id: "c", brief: "查 C", by: "subagent", after: ["a", "b"] },
            ],
          }),
        ]);
      return answer("派好了");
    };
    await withAgent(
      dir,
      Array.from({ length: 12 }, () => reply),
      async (r) => {
        await r.ask("查三样");
        await until(() => sent.length === 3 && told === 3);
        expect(await Effect.runPromise(store.load)).toEqual([]);
      },
      { tasks: store, reminders: false },
    );
  });

  it("calls the subagents back when the agent is stopped", async () => {
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
      if (!answered(c)) return answer([toolCall("task_add", { tasks: [{ id: "a", brief: "查 A", by: "subagent" }] })]);
      return answer("派好了");
    };
    await withAgent(
      dir,
      Array.from({ length: 4 }, () => reply),
      async (r) => {
        expect(await r.ask("查")).toBe("派好了");
        await until(() => started);
        await r.agent.stop();
        const g = await Effect.runPromise(store.load);
        expect(g[0]).toMatchObject({ state: "waiting" });
        expect(g[0]!.tries ?? 0).toBe(0);
      },
      { tools: [wait], tasks: store, reminders: false },
    );
  });

  // A run that stops with its own tasks ready is reminded, at most maxNudges times while the graph stays the same.
  it("reminds a stopped run of its own tasks a few times", async () => {
    const dir = home();
    let nudged = 0;
    const reply = (c: Request): Answer => {
      if (lastUser(c).includes("这一轮停了，还有 2 件你可以做：a、b")) {
        nudged++;
        return answer("还没空");
      }
      if (!answered(c))
        return answer([
          toolCall("task_add", {
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
        await until(() => nudged >= 2);
        await until(() => !r.agent.busy());
        expect(nudged).toBe(2);
        events = [...r.events];
      },
      { tasks: memoryStore(), maxNudges: 2, reminders: false },
    );
    const changed = events.filter((e) => e.type === "tasks_changed");
    // The task was one change.
    expect(changed.length).toBe(1);
    expect(changed[0]!.type === "tasks_changed" && changed[0]!.tasks.length).toBe(2);
  });

  it("carries the open graph into a fold's summary", async () => {
    const store = memoryStore();
    const summaries = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* makeTaskRunner(store, undefined, () => Effect.void);
          const before = yield* runner.summary;
          yield* store.change((g) => engine.add(g, [{ id: "a", brief: "读" }])[0]);
          return [before, yield* runner.summary];
        }),
      ),
    );
    expect(summaries).toEqual(["", "【整理对话时的任务，以 tasks 为准】\n任务（1 件，1 件可以做）：\n- [可以做] a 读"]);
  });
});
