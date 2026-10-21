import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type FauxContentBlock,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as engine from "./taskGraph.ts";
import { memoryStore } from "./taskStore.ts";
import { Brain, type BrainEvent, type BrainOptions } from "./agent.ts";
import { applyPlan, planCompaction } from "./compaction.ts";
import { messageText, userMessage } from "./messages.ts";
import { RunAccounting, type RunResult } from "./run.ts";
import { SessionFile } from "./session.ts";
import { TaskRunner } from "./tasks.ts";
import { answered, fauxLLM, lastUser, type Request, systemPrompt, tempHome, until, withAgent } from "./testing.ts";
import { objectSchema, textTool } from "./tool.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

const billed = (content: string | FauxContentBlock | FauxContentBlock[], input: number, output: number, cache: number): AssistantMessage => {
  const m = fauxAssistantMessage(content);
  return {
    ...m,
    usage: {
      input,
      output,
      cacheRead: cache,
      cacheWrite: 0,
      totalTokens: input + output + cache,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
};
const echo = textTool<object>({ name: "echo", description: "", parameters: objectSchema(), run: () => "ok" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers as given, usage and all (the faux provider counts its own); hang: the last answer starts and never ends. */
function scripted(steps: AssistantMessage[], hang = false) {
  const { llm } = fauxLLM();
  const stream: StreamFn = (_model, _context, options) => {
    const out = createAssistantMessageEventStream();
    const m = steps.shift()!;
    const last = steps.length === 0;
    queueMicrotask(() => {
      out.push({ type: "start", partial: m });
      if (hang && last) {
        out.push({ type: "text_delta", contentIndex: 0, delta: messageText(m), partial: m });
        options?.signal?.addEventListener("abort", () => out.push({ type: "error", reason: "aborted", error: { ...m, stopReason: "aborted" } }));
        return;
      }
      if (m.stopReason === "error" || m.stopReason === "aborted") out.push({ type: "error", reason: m.stopReason, error: m });
      else out.push({ type: "done", reason: m.stopReason as "stop", message: m });
    });
    return out;
  };
  return { ...llm, stream };
}

async function receiptAgent(steps: AssistantMessage[], extra: Partial<BrainOptions> = {}) {
  const llm = scripted(steps);
  const dir = home();
  const agent = await Brain.start({
    name: "receipt",
    instructions: "",
    llm,
    home: dir,
    cwd: dir,
    noSkills: true,
    noMemory: true,
    noSubagents: true,
    noSession: true,
    schedules: false,
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
    const tool = fauxToolCall("echo", {});
    const { agent, receipts } = await receiptAgent(
      [billed([tool], 10, 2, 3), billed([tool], 20, 4, 5), billed("first", 30, 6, 7), billed("second", 40, 8, 9)],
      { tools: [echo] },
    );
    expect(await agent.ask(userMessage("one"))).toBe("first");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ id: 1, settled: true, usage: { input: 60, output: 12, cacheRead: 15 }, contextTokens: 43 });
    expect(await agent.ask(userMessage("two"))).toBe("second");
    await until(() => receipts.length === 2);
    expect(receipts[1]).toMatchObject({ id: 2, usage: { input: 40 } });
    expect(agent.progress().lifetime).toMatchObject({ input: 100, output: 20, cacheRead: 24 });
    await agent.close();
  });

  it("keeps a failure's words and goes by the last answer", async () => {
    const failed = { ...billed("failed words", 7, 2, 1), stopReason: "error" as const, errorMessage: "broken" };
    const { agent, receipts } = await receiptAgent([failed, billed("recovered", 3, 1, 0)]);
    expect(await agent.ask(userMessage("fail"))).toBe("failed words");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ error: "broken", usage: { input: 7 } });
    await agent.ask(userMessage("retry"));
    await until(() => receipts.length === 2);
    expect(receipts[1]).toMatchObject({ error: "", usage: { input: 3 } });
    await agent.close();
    const accounting = new RunAccounting();
    accounting.begin();
    accounting.message(failed);
    accounting.message(billed("ok", 3, 1, 0));
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
      [billed([fauxText("A"), fauxToolCall("echo", {})], 2, 1, 0), billed("A done", 3, 1, 0), billed([fauxToolCall("echo", {})], 4, 1, 0)],
      {
        tools: [slow],
        maxSteps: 3,
      },
    );
    const answer = agent.ask(userMessage("A"));
    await until(() => entered);
    agent.later(userMessage("B"));
    release();
    expect(await answer).toBe("");
    await until(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ id: 1, text: "", usage: { input: 9 } });
    await agent.close();
  });

  it("shows usage from an answer that has only started, and does not count it twice", () => {
    const accounting = new RunAccounting();
    const message = billed("reported at start", 9, 2, 3);
    accounting.begin();
    accounting.partial(message);
    expect(accounting.snapshot().current).toMatchObject({ usage: { input: 9 }, settled: false });
    accounting.message(message);
    expect(accounting.snapshot()).toMatchObject({ lifetime: { input: 9 }, current: { usage: { output: 2 } } });
  });

  it("keeps an answer cut off by closing, with what it used", async () => {
    const llm = scripted([billed("partial", 7, 3, 2)], true);
    const dir = home();
    const agent = await Brain.start({
      name: "partial",
      instructions: "",
      llm,
      home: dir,
      cwd: dir,
      noSkills: true,
      noMemory: true,
      noSubagents: true,
      noSession: true,
      schedules: false,
    });
    const events: BrainEvent[] = [];
    agent.subscribe((e) => events.push(e));
    agent.send(userMessage("start"));
    await until(() => events.some((e) => e.type === "message_update"));
    expect(agent.progress().current.settled).toBe(false);
    await Promise.all(Array.from({ length: 8 }, () => agent.close()));
    expect(agent.progress()).toMatchObject({ current: { settled: true, aborted: true }, lifetime: { input: 7, output: 3, cacheRead: 2 } });
    const receipt = events.find((e) => e.type === "agent_settled");
    expect(receipt?.type === "agent_settled" && receipt.run).toMatchObject({ usage: { input: 7, output: 3 }, text: "partial" });
  });
});

describe("a compaction", () => {
  it("replays its whole kept tail", () => {
    const dir = home();
    const messages: AgentMessage[] = [
      userMessage("old"),
      fauxAssistantMessage("old answer"),
      userMessage("keep"),
      fauxAssistantMessage("a"),
      fauxAssistantMessage("b"),
      fauxAssistantMessage("c"),
    ];
    const options = { budget: 1, keepRecent: 2, keepSaid: 0 };
    const initial = planCompaction(messages, options)!;
    const cached = { role: "compactionSummary" as const, summary: "summary", tokensBefore: 0, timestamp: 0, kept: messages.length - initial.cut };
    messages.push(fauxAssistantMessage("late tail"));
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

const helperBrief = (c: Request) => messageText(c.messages[1]!);

describe("the agent's task graph", () => {
  // A and B go out together; C waits for both, then goes; each comes back to the agent as an input.
  it("sends a helper's tasks when ready, and they come back", async () => {
    const dir = home();
    const store = memoryStore();
    const sent: string[] = [];
    let told = 0;
    const reply = (context: { messages: unknown[] }) => {
      const c = context as Request;
      if (systemPrompt(c).includes("派出去的帮手")) {
        const brief = helperBrief(c);
        if (brief === "查 C") expect(sent).toEqual(expect.arrayContaining(["查 A", "查 B"]));
        sent.push(brief);
        return fauxAssistantMessage(brief + " 做完了");
      }
      if (messageText(c.messages.at(-1)!).includes("〔任务〕")) {
        told++;
        return fauxAssistantMessage("收到");
      }
      if (!answered(c))
        return fauxAssistantMessage([
          fauxToolCall("task_add", {
            tasks: [
              { id: "a", brief: "查 A", by: "helper" },
              { id: "b", brief: "查 B", by: "helper" },
              { id: "c", brief: "查 C", by: "helper", after: ["a", "b"] },
            ],
          }),
        ]);
      return fauxAssistantMessage("派好了");
    };
    await withAgent(
      dir,
      Array.from({ length: 12 }, () => reply),
      async (r) => {
        await r.ask("查三样");
        await until(() => sent.length === 3 && told === 3);
        expect(await Effect.runPromise(store.load)).toEqual([]);
      },
      { tasks: store, schedules: false },
    );
  });

  it("calls the helpers back when the agent is stopped", async () => {
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
    const reply = (context: { messages: unknown[] }) => {
      const c = context as Request;
      if (systemPrompt(c).includes("派出去的帮手")) return fauxAssistantMessage([fauxToolCall("wait", {})]);
      if (!answered(c)) return fauxAssistantMessage([fauxToolCall("task_add", { tasks: [{ id: "a", brief: "查 A", by: "helper" }] })]);
      return fauxAssistantMessage("派好了");
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
      { tools: [wait], tasks: store, schedules: false },
    );
  });

  // A run that stops with its own tasks ready is reminded, at most maxNudges times while the graph stays the same.
  it("reminds a stopped run of its own tasks a few times", async () => {
    const dir = home();
    let nudged = 0;
    const reply = (context: { messages: unknown[] }) => {
      const c = context as Request;
      if (lastUser(c).includes("这一轮停了，还有 2 件你可以做：a、b")) {
        nudged++;
        return fauxAssistantMessage("还没空");
      }
      if (!answered(c))
        return fauxAssistantMessage([
          fauxToolCall("task_add", {
            tasks: [
              { id: "a", brief: "读" },
              { id: "b", brief: "写" },
            ],
          }),
        ]);
      return fauxAssistantMessage("先这样");
    };
    let events: BrainEvent[] = [];
    await withAgent(
      dir,
      Array.from({ length: 10 }, () => reply),
      async (r) => {
        await r.ask("拆一下");
        await until(() => nudged >= 2);
        await sleep(300);
        expect(nudged).toBe(2);
        events = [...r.events];
      },
      { tasks: memoryStore(), maxNudges: 2, schedules: false },
    );
    const changed = events.filter((e) => e.type === "tasks_changed");
    // The task was one change.
    expect(changed.length).toBe(1);
    expect(changed[0]!.type === "tasks_changed" && changed[0]!.tasks.length).toBe(2);
  });

  it("carries the open graph into a fold's summary", async () => {
    const store = memoryStore();
    const runner = new TaskRunner(store, undefined, new AbortController().signal, () => {});
    expect(await runner.summary()).toBe("");
    await Effect.runPromise(store.change((g) => Effect.succeed(engine.add(g, [{ id: "a", brief: "读" }])[0])));
    expect(await runner.summary()).toBe("【整理对话时的任务，以 tasks 为准】\n任务（1 件，1 件可以做）：\n- [可以做] a 读");
  });
});
