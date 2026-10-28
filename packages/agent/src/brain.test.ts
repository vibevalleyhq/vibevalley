import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { resumedUnknown, sessionUnfinished } from "./brain.ts";
import { cutPoint, summaryInPlace, summaryInstructions } from "./compaction.ts";
import { forgetLine, memoryFile, readMemory, remember } from "./memory.ts";
import { type BrainMessage, type CompactionSummaryMessage, messageText, userMessage } from "./messages.ts";
import { SessionFile } from "./session.ts";
import { answered, lastUser, type Request, results, type Rig, scriptedLLM, type Step, systemPrompt, tempHome, toolsOf, until, withAgent } from "./testing.ts";
import { stopped, textTool } from "./core/tool.ts";
import { type Answer, answer, assistantMessage, text, thinking, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";
import { gate, nextTurn, whenTrue } from "@vibevalley/testkit/until";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

const step = (f: (r: Request) => Answer): Step => f;
const roles = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { role: string }).role);
const said = (messages: readonly BrainMessage[]) => messages.map((m) => m.role + ":" + messageText(m));
const summarizing = (r: Pick<Request, "messages">) => lastUser(r) === summaryInPlace;
const prefixChanges = (r: Rig) => r.events.flatMap((e) => (e.type === "prefix_changed" ? [e.parts.join(",")] : []));
const settled = (r: Rig) => r.events.find((e) => e.type === "agent_settled") as { run: { aborted: boolean } } | undefined;
const repeat = <A>(n: number, a: A) => Array.from({ length: n }, () => a);

describe("the agent", () => {
  it("stops waiting for an ask that is interrupted, and goes on with the run", async () => {
    const dir = home();
    const wake = gate();
    let napping = false;
    const nap = textTool<object>({
      name: "nap",
      description: "睡一会",
      parameters: objectSchema(),
      run: async () => {
        napping = true;
        await wake.opened;
        return "醒了";
      },
    });
    await withAgent(
      dir,
      [answer([toolCall("nap", {})]), answer("睡好了")],
      async (r) => {
        const asking = Effect.runFork(r.agent.brain.ask(userMessage("睡", Date.now())));
        await until(() => napping);
        await Effect.runPromise(Fiber.interrupt(asking));
        wake.open();
        await until(() => r.has("agent_settled"));
        expect(messageText(r.agent.history().at(-1)!)).toBe("睡好了");
      },
      { tools: [nap] },
    );
  });

  it("shares the actual close with every concurrent caller", async () => {
    const dir = home();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { llm } = scriptedLLM();
    const held = {
      ...llm,
      service: { ...llm.service, stream: () => Stream.fromEffect(Effect.uninterruptible(Effect.promise(() => gate))).pipe(Stream.drain) },
    };
    await withAgent(
      dir,
      [],
      async (r) => {
        await r.agent.send(userMessage("说", Date.now()));
        await until(() => r.has("message_end"));
        try {
          const first = r.agent.close();
          const second = r.agent.close();
          expect(second).toBe(first);
          let done = false;
          void second.then(() => {
            done = true;
          });
          // A close that did not wait for the gate would have ended by the next turn.
          await nextTurn();
          expect(done).toBe(false);
          release();
          await Promise.all([first, second]);
          expect(done).toBe(true);
        } finally {
          release();
        }
      },
      { llm: held },
    );
  });

  it("cuts off a run under way when its owner's scope closes", async () => {
    let [started, cut] = [false, false];
    const owner = Scope.makeUnsafe();
    const { llm } = scriptedLLM();
    const asked = Effect.onInterrupt(
      Effect.andThen(
        Effect.sync(() => (started = true)),
        Effect.never,
      ),
      () => Effect.sync(() => (cut = true)),
    );
    const held = { ...llm, service: { ...llm.service, stream: () => Stream.fromEffect(asked) } };
    await withAgent(
      home(),
      [],
      async (r) => {
        void r.agent.send(userMessage("说", Date.now()));
        await until(() => started);
        await Effect.runPromise(Scope.close(owner, Exit.void));
        await until(() => cut);
      },
      { llm: held },
      { run: (effect) => Effect.runPromise(effect), scope: owner },
    );
  });

  it("runs a tool and gives its result back", async () => {
    const dir = home();
    writeFileSync(join(dir, "notes.txt"), "第一行\n第二行\n");
    await withAgent(
      dir,
      [
        answer([thinking("先读文件"), toolCall("read_file", { path: "notes.txt" })]),
        step((c) => answer(results(c)[0]?.text.includes("第二行") ? "读到了：两行" : "读到了：没读到")),
      ],
      async (r) => {
        expect(await r.ask("看看 notes.txt")).toBe("读到了：两行");
        await until(() => r.has("agent_settled"));
        expect(r.events.flatMap((e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end" ? [e.type + ":" + e.toolName] : []))).toEqual([
          "tool_execution_start:read_file",
          "tool_execution_end:read_file",
        ]);
        // The thinking goes back with the answer it came with.
        expect(r.requests[1]!.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "thinking" && c.thinking === "先读文件"))).toBe(
          true,
        );
        expect(r.events.at(-1)!.type).toBe("agent_settled");
      },
    );
    expect(roles(readFileSync(join(dir, "test.jsonl"), "utf8"))).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("tells the model why a tool failed", async () => {
    const dir = home();
    writeFileSync(join(dir, "a.txt"), "x x\n");
    await withAgent(
      dir,
      [
        answer([toolCall("edit_file", { path: "a.txt", old_text: "x", new_text: "y" }), toolCall("read_file", { file: "oops" })]),
        step((c) =>
          answer(
            results(c)
              .map((x) => `${x.failed}:${[...x.text].slice(0, 12).join("")}`)
              .join("|"),
          ),
        ),
      ],
      async (r) => {
        expect(await r.ask("改")).toMatch(/^true:old_text 在 a\|true:\S/);
      },
    );
  });

  it("steers with send and waits with later", async () => {
    const dir = home();
    // The nap lasts until the test has said its two lines: they come while the tool runs.
    const wake = gate();
    let napping = false;
    const nap = textTool<object>({
      name: "nap",
      description: "睡一会",
      parameters: objectSchema(),
      run: async () => {
        napping = true;
        await wake.opened;
        return "醒了";
      },
    });
    await withAgent(
      dir,
      [answer([toolCall("nap", {})]), step((c) => answer("第二次听到：" + lastUser(c))), step((c) => answer("第三次听到：" + lastUser(c)))],
      async (r) => {
        await r.agent.send(userMessage("开始", Date.now()));
        await until(() => napping);
        await r.agent.later(userMessage("完了再说这个", Date.now()));
        await r.agent.send(userMessage("顺便", Date.now()));
        wake.open();
        await until(() => r.agent.history().length >= 7);
        expect(said(r.agent.history())).toEqual([
          "user:开始",
          "assistant:",
          "toolResult:醒了",
          "user:顺便",
          "assistant:第二次听到：顺便",
          "user:完了再说这个",
          "assistant:第三次听到：完了再说这个",
        ]);
      },
      { tools: [nap] },
    );
  });

  it("stops at its step limit", async () => {
    const dir = home();
    await withAgent(
      dir,
      repeat(4, answer([toolCall("list_dir", {})])),
      async (r) => {
        await r.ask("一直列");
        expect(r.requests.length).toBe(3);
      },
      { maxSteps: 3 },
    );
  });

  it("goes on with its session when started again", async () => {
    const dir = home();
    const countUsers = step((c) => answer(`第 ${c.messages.filter((m) => m.role === "user").length} 句`));
    await withAgent(dir, [countUsers], async (r) => expect(await r.ask("一")).toBe("第 1 句"));
    await withAgent(dir, [countUsers], async (r) => expect(await r.ask("二")).toBe("第 2 句"));
  });

  it("folds a long conversation", async () => {
    const dir = home();
    const long = step((c) => answer(summarizing(c) ? "摘要：说了五件事" : "好的。".repeat(150)));
    const options = { contextTokens: 900, keepRecent: 2 };
    await withAgent(
      dir,
      repeat(12, long),
      async (r) => {
        for (let n = 1; n <= 5; n++) await r.ask(`第 ${n} 件事`);
        await until(() => r.events.some((e) => e.type === "compaction_end" && e.compaction !== undefined));
        const last = r.requests.filter((c) => !summarizing(c)).at(-1)!;
        expect(messageText(last.messages[0]!)).toMatch(/^【之前的对话压成了下面的摘要，原文在 .*archive.*】\n<summary>\n摘要：说了五件事/);
        expect(r.agent.history()[0]!.role).toBe("compactionSummary");
      },
      options,
    );
    expect(readdirSync(join(dir, "archive")).length).toBeGreaterThanOrEqual(1);
    await withAgent(
      dir,
      [],
      async (r) => {
        const history = r.agent.history();
        expect(history[0]!.role).toBe("compactionSummary");
        expect(history.length).toBeLessThanOrEqual(6);
      },
      options,
    );
  });

  it("lists its skills and reads one", async () => {
    const dir = home();
    mkdirSync(join(dir, "skills", "tidy"), { recursive: true });
    writeFileSync(join(dir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: 整理代码时用\n---\n先跑 lint");
    await withAgent(
      dir,
      [answer([toolCall("load_skill", { name: "tidy" })]), step((c) => answer(results(c)[0]!.text.split("\n").at(-1)!))],
      async (r) => {
        expect(await r.ask("整理一下")).toBe("先跑 lint");
        expect(systemPrompt(r.requests[0]!)).toContain("- tidy：整理代码时用");
      },
      { noSkills: false, skills: [join(dir, "skills")] },
    );
  });

  it("sends subagents that work side by side", async () => {
    const dir = home();
    let running = 0;
    let most = 0;
    const nap = textTool<object>({
      name: "nap",
      description: "睡一会",
      parameters: objectSchema(),
      run: async () => {
        most = Math.max(most, ++running);
        // Each waits for the other: side by side they both get here, one after the other they never would.
        await whenTrue(() => most >= 2, "both subagents napping at once");
        running--;
        return "醒了";
      },
    });
    const subagentOrNot = step((c) => {
      if (systemPrompt(c).includes("派出去的帮手")) return answered(c) ? answer(messageText(c.messages[0]!) + " 做完了") : answer([toolCall("nap", {})]);
      if (!answered(c)) return answer([toolCall("spawn_agent", { brief: "查 A" }), toolCall("spawn_agent", { brief: "查 B" })]);
      return answer(
        results(c)
          .map((x) => x.text)
          .join("；"),
      );
    });
    await withAgent(
      dir,
      repeat(6, subagentOrNot),
      async (r) => {
        expect(await r.ask("同时查 A 和 B")).toBe("查 A 做完了；查 B 做完了");
        expect(most).toBe(2);
      },
      { tools: [nap], reminders: false },
    );
  });

  it("is woken by a reminder that comes due", async () => {
    const dir = home();
    writeFileSync(
      join(dir, "reminders.json"),
      `[{"id":"reminder-1","name":"早报","message":"汇总昨天的进展","at":"2026-01-01T00:00:00.000Z","created":"2026-01-01T00:00:00.000Z"}]`,
    );
    await withAgent(dir, [step((c) => answer("收到：" + lastUser(c)))], async (r) => {
      await until(() => r.has("agent_settled"));
      const history = r.agent.history();
      expect(history[0]!.role).toBe("custom");
      expect(messageText(history[1]!)).toBe("收到：【提醒「早报」到点了（reminder-1）】\n汇总昨天的进展");
    });
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toEqual([]);
  });

  effectIt.effect("is woken when a reminder comes due an hour later, at the next 20 s tick, not before", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-01T08:00:00.000Z"));
      const move = Effect.runPromiseWith(yield* Effect.context<never>());
      const scope = yield* Effect.scope;
      const dir = home();
      writeFileSync(
        join(dir, "reminders.json"),
        `[{"id":"reminder-1","name":"早报","message":"汇总昨天的进展","at":"2026-03-01T09:00:00.000Z","created":"2026-03-01T08:00:00.000Z"}]`,
      );
      yield* Effect.promise(() =>
        withAgent(
          dir,
          [step((c) => answer("收到：" + lastUser(c)))],
          async (r) => {
            await move(TestClock.adjust(59 * 60_000));
            expect(r.has("agent_start")).toBe(false);
            await move(TestClock.adjust(60_000 + 20_000));
            await until(() => r.has("agent_settled"));
            expect(messageText(r.agent.history()[1]!)).toBe("收到：【提醒「早报」到点了（reminder-1）】\n汇总昨天的进展");
          },
          {},
          { run: move, scope },
        ),
      );
    }),
  );

  it("keeps the same system prompt between folds and tells memory news in the input", async () => {
    const dir = home();
    writeFileSync(memoryFile(dir), "- 2026-10-01 主人叫阿周\n- 2026-10-02 用中文\n");
    await withAgent(dir, [answer("一"), answer("二")], async (r) => {
      expect(r.agent.memoryNews()).toBe("");
      await r.ask("a");
      remember(dir, "主人喜欢短句", new Date(2026, 9, 18, 9));
      forgetLine(dir, readMemory(dir).lines.find((l) => l.text === "用中文")!.id);
      const news = r.agent.memoryNews();
      expect(news).toBe("【记性有更新】\n+ 2026-10-18 主人喜欢短句\n− 2026-10-02 用中文");
      expect(r.agent.memoryNews()).toBe("");
      await r.ask(news + "\n\nb");
      expect(systemPrompt(r.requests[1]!)).toBe(systemPrompt(r.requests[0]!));
      expect(systemPrompt(r.requests[0]!)).toMatch(/主人叫阿周\n- 2026-10-02 用中文$/);
      expect(lastUser(r.requests[1]!)).toMatch(/^【记性有更新】/);
      expect(prefixChanges(r)).toEqual([]);
    });
  });

  it("makes the system prompt anew after a fold", async () => {
    const dir = home();
    const long = step((c) => answer(summarizing(c) ? "摘要" : "好的。".repeat(150)));
    await withAgent(
      dir,
      repeat(12, long),
      async (r) => {
        await r.ask("第 1 件事");
        remember(dir, "记在折叠之前", new Date());
        const folded = () => r.events.some((e) => e.type === "compaction_end" && e.compaction !== undefined);
        for (let n = 2; n <= 5 && !folded(); n++) await r.ask(`第 ${n} 件事`);
        await until(folded);
        await r.ask("折叠之后");
        const prompts = r.requests.filter((c) => !summarizing(c)).map(systemPrompt);
        expect(prompts[0]).not.toContain("记在折叠之前");
        expect(prompts.at(-1)).toContain("记在折叠之前");
        expect(prefixChanges(r)).toEqual([]);
      },
      { contextTokens: 900, keepRecent: 2 },
    );
  });

  it("stops the run under way", async () => {
    const dir = home();
    await withAgent(
      dir,
      [answer([text("这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的回答".repeat(20))], { hangAfter: 50 })],
      async (r) => {
        await r.agent.send(userMessage("说", Date.now()));
        await until(() => r.events.some((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta"));
        await r.agent.stop();
        await until(() => r.has("agent_settled"));
        expect(settled(r)!.run.aborted).toBe(true);
        const last = r.agent.history().at(-1)!;
        expect(last.role === "assistant" && last.stopReason).toBe("aborted");
      },
    );
  });

  it("is stopped while a tool runs", async () => {
    const dir = home();
    await withAgent(dir, [answer([toolCall("bash", { command: "sleep 5" })])], async (r) => {
      await r.agent.send(userMessage("睡", Date.now()));
      await until(() => r.has("tool_execution_start"));
      await r.agent.stop();
      await until(() => r.has("agent_settled"));
      expect(settled(r)!.run.aborted).toBe(true);
      const last = r.agent.history().at(-1)!;
      expect(last.role).toBe("toolResult");
    });
  });

  it("reads back a session file", () => {
    const dir = home();
    const lines = [
      `{"role":"user","content":"一","timestamp":1}`,
      `{"role":"assistant","content":[{"type":"text","text":"好"}],"api":"openai-completions","provider":"deepseek","model":"deepseek-flash","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2,"durationMs":5}`,
      `{"role":"custom","customType":"farmNews","content":"老周做完了","display":false,"timestamp":3}`,
      `{"role":"compactionSummary","summary":"摘要","tokensBefore":900,"timestamp":4,"archive":"/x/archive/orchestrator.md","kept":2}`,
      `{"role":"user","content":"二","timestamp":5}`,
    ];
    writeFileSync(join(dir, "orchestrator.jsonl"), lines.join("\n") + '\n{"role":"us');
    const history = new SessionFile(join(dir, "orchestrator.jsonl")).load();
    expect(said(history)).toEqual(["compactionSummary:摘要", "assistant:好", "custom:老周做完了", "user:二"]);
    expect(history.map((m) => JSON.stringify(m))).toEqual([lines[3], lines[1], lines[2], lines[4]]);
  });

  it("tells a changed tool as a changed prefix", async () => {
    const dir = home();
    await withAgent(dir, [answer("一"), answer("二")], async (r) => {
      await r.ask("a");
      await until(() => r.has("agent_settled"));
      expect(prefixChanges(r)).toEqual([]);
      (r.agent.tools()[0] as { description: string }).description = "改过的说明";
      await r.ask("b");
      await until(() => prefixChanges(r).length > 0);
      expect(prefixChanges(r)[0]).toContain("tools");
    });
  });

  describe("an idle conversation", () => {
    const idleRig = async (
      wakeSoon: ((ms: number) => boolean) | undefined,
      summary: (c: Request) => Answer,
      body: (r: Rig, choices: Map<number, unknown>) => Promise<void>,
    ) => {
      const dir = home();
      const choices = new Map<number, unknown>();
      let calls = 0;
      const reply = (c: Request): Answer => {
        calls++;
        if (summarizing(c)) {
          choices.set(calls, c.options.toolChoice);
          return summary(c);
        }
        if (systemPrompt(c).startsWith(summaryInstructions)) return answer("另起的摘要");
        return answer("好的。".repeat(150));
      };
      await withAgent(dir, repeat(8, reply), (r) => body(r, choices), {
        keepRecent: 2,
        idleFoldAt: 300,
        idleFoldAfterMs: 50,
        ...(wakeSoon ? { wakeSoon } : {}),
      });
    };
    const idleFolded = (r: Rig) => r.events.some((e) => e.type === "compaction_end" && e.reason === "idle" && e.compaction !== undefined);

    it("is folded with the same start", async () => {
      await idleRig(
        undefined,
        () => answer("就地的摘要"),
        async (r, choices) => {
          for (const words of ["一", "二", "三"]) await r.ask(words);
          expect(r.requests.length).toBe(3);
          await until(() => idleFolded(r));
          expect(r.requests.length).toBe(4);
          const [before, folding] = [r.requests[2]!, r.requests[3]!];
          expect(systemPrompt(folding)).toBe(systemPrompt(before));
          expect(JSON.stringify(toolsOf(folding))).toBe(JSON.stringify(toolsOf(before)));
          expect(JSON.stringify(folding.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages));
          expect(folding.messages.length).toBe(before.messages.length + 2);
          expect([...choices.values()]).toEqual(["none"]);
          const history = r.agent.history();
          expect((history[0] as CompactionSummaryMessage).summary).toBe("就地的摘要");
          expect(said(history.slice(1))).toEqual(["user:三", "assistant:" + "好的。".repeat(150)]);
        },
      );
    });

    it("asks again on its own when a tool is called instead of a summary", async () => {
      await idleRig(
        undefined,
        () => answer([toolCall("list_dir", {})]),
        async (r) => {
          for (const words of ["一", "二", "三"]) await r.ask(words);
          await until(() => idleFolded(r));
          expect((r.agent.history()[0] as CompactionSummaryMessage).summary).toBe("另起的摘要");
        },
      );
    });

    it("is not folded when it will be woken soon", async () => {
      let asked = 0;
      await idleRig(
        (within) => {
          expect(within).toBe(50);
          asked++;
          return true;
        },
        () => answer("摘要"),
        async (r) => {
          for (const words of ["一", "二", "三"]) await r.ask(words);
          await until(() => asked > 0);
          await until(() => !r.agent.busy());
          expect(asked).toBe(1);
          expect(r.requests.length).toBe(3);
          expect(r.agent.history()[0]!.role).toBe("user");
        },
      );
    });
  });

  it("cuts where the last words stay", () => {
    const u = (text: string) => userMessage(text, Date.now());
    const a = (words: string) => assistantMessage(words);
    const call = assistantMessage([toolCall("x", {})]);
    const result: BrainMessage = {
      role: "toolResult",
      toolCallId: "",
      toolName: "x",
      content: [],
      isError: false,
      timestamp: 0,
    };
    const tools = [u("1"), a("一"), u("2"), a("二"), u("3"), call, result, call, result, call, result, a("三"), u("4"), call, result, a("四")];
    expect(cutPoint(tools, 3, 0)).toBe(12);
    expect(cutPoint(tools, 3, 3)).toBe(2);
    expect(cutPoint(tools, 3, 2)).toBe(4);
    expect(cutPoint(tools, 3, 1)).toBe(12);
    expect(cutPoint(tools, 3, 5)).toBe(0);
    expect(cutPoint([], 2, 3)).toBe(0);
  });

  describe("a run cut off", () => {
    const now = Date.now();
    const asked: BrainMessage = { role: "user", content: "列一下", timestamp: now };
    const call = assistantMessage([toolCall("list_dir", {}, "call-1")], {
      timestamp: now,
      stopReason: "toolUse",
    });
    const result: BrainMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "list_dir",
      content: [{ type: "text", text: "（空的）" }],
      isError: false,
      timestamp: now,
    };
    const old = { ...result, timestamp: now - 2 * 3_600_000 };
    const stop: BrainMessage = {
      ...result,
      content: [{ type: "text", text: stopped }],
      isError: true,
    };
    const done = assistantMessage("列完了");
    const cases: [string, BrainMessage[], boolean, boolean][] = [
      ["a tool done, not answered", [asked, call, result], true, true],
      ["cut off in a tool", [asked, call], true, true],
      ["answered", [asked, call, result, done], false, false],
      ["two hours ago", [asked, call, old], true, false],
      ["stopped", [asked, call, stop], false, false],
    ];
    for (const [name, lines, isUnfinished, resumed] of cases)
      it(name, async () => {
        const dir = home();
        const file = join(dir, "test.jsonl");
        writeFileSync(file, lines.map((m) => JSON.stringify(m)).join("\n") + "\n");
        expect(sessionUnfinished(file)).toBe(isUnfinished);
        await withAgent(dir, [step((c) => answer(JSON.stringify(results(c))))], async (r) => {
          expect(await r.agent.resume(30 * 60_000)).toBe(resumed);
          if (!resumed) {
            // Not resumed: nothing was started to wait for.
            expect(r.requests.length).toBe(0);
            return;
          }
          await until(() => r.has("agent_settled"));
          expect(r.requests.length).toBe(1);
          expect(results(r.requests[0]!)).toEqual(
            name === "cut off in a tool" ? [{ failed: true, text: resumedUnknown }] : [{ failed: false, text: "（空的）" }],
          );
        });
        if (resumed)
          expect(roles(readFileSync(file, "utf8")).slice(lines.length)).toEqual(name === "cut off in a tool" ? ["toolResult", "assistant"] : ["assistant"]);
      });
  });

  it("drops the tools it is told not to have only after all are assembled", async () => {
    const dir = home();
    const blocked = ["custom", "load_skill", "spawn_agent", "reminder", "list_reminders", "cancel_reminder"];
    await withAgent(
      dir,
      [],
      async (r) => {
        const names = r.agent.tools().map((t) => t.name);
        for (const b of blocked) expect(names).not.toContain(b);
        expect(names).toContain("remember");
        expect(names).toContain("search_archive");
      },
      {
        noSession: true,
        reminders: true,
        tools: [textTool({ name: "custom", description: "", parameters: objectSchema(), run: () => "" })],
        disallowedTools: blocked,
      },
    );
    expect(existsSync(join(dir, "test.jsonl"))).toBe(false);
  });
});
