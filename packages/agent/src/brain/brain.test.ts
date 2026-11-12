import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { type Answer, answer, assistantMessage, text, thinking, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";
import { gate, until, waitFor, whenTrue } from "@vibevalley/testkit/until";

import { type BrainMessage, type CompactionSummaryMessage, messageText, userMessage } from "../base/messages.ts";
import { stopped, textTool } from "../core/tool.ts";
import {
  answered,
  lastUser,
  type Request,
  results,
  type Rig,
  scriptedLLM,
  type Step,
  systemPrompt,
  tempHome,
  testBrain,
  testClock,
  toolsOf,
  withAgent,
} from "../testing/testing.ts";
import { forgetLine, memoryFile, readMemory, remember } from "../tools/memory.ts";
import { makeBrain, resumedUnknown, sessionUnfinished } from "./brain.ts";
import { cutPoint, summaryInPlace, summaryInstructions } from "./compaction.ts";
import { loadSession } from "./session.ts";

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
  test("the fixture observes the first event and each target run before ask returns, then closes", async () => {
    const epoch = 1798758000000;
    const clock = testClock(epoch);
    const rig = await withAgent(
      home(),
      [answer("first"), answer("second")],
      async (r) => {
        const observed: string[] = [];
        let observerEnded = false;
        const stream = r.agent.events();
        const observer = (async () => {
          try {
            for await (const e of stream) observed.push(e.type);
          } finally {
            observerEnded = true;
          }
        })();
        const answer2 = await r.ask("one");
        expect(answer2).toBe("first");
        expect(r.events[0]?.type).toBe("agent_start");
        expect(r.events.at(-1)).toMatchObject({ type: "agent_settled", run: { id: 1, settled: true } });
        expect(r.agent.history()[0]).toMatchObject({ role: "user", timestamp: epoch });
        await until(() => observed.at(-1) === "agent_settled", "the independent observer consumed the first run");
        expect(observed[0]).toBe("agent_start");
        stream.close();
        await observer;
        expect(observerEnded).toBe(true);
        const beforeSecondRun = [...observed];
        await clock.adjust(25);
        const answer3 = await r.ask("two");
        expect(answer3).toBe("second");
        expect(r.events.filter((e) => e.type === "agent_settled").map((e) => e.run.id)).toEqual([1, 2]);
        expect(r.events.at(-1)).toMatchObject({ type: "agent_settled", run: { id: 2, settled: true } });
        expect(r.agent.progress().current.id).toBe(2);
        expect(r.agent.history()[2]).toMatchObject({ role: "user", timestamp: epoch + 25 });
        expect(observed).toEqual(beforeSecondRun);
        return r;
      },
      { clock },
    );
    const observed = [...rig.events];
    const answerFailure = await rig.ask("closed").catch((e: unknown) => e);
    expect(answerFailure).toMatchObject({ _tag: "AgentClosed" });
    const now = clock.now();
    await rig.agent.send(userMessage("ignored", now));
    await clock.adjust(3_600_000);
    expect(rig.events).toEqual(observed);
    expect(rig.requests).toHaveLength(2);
  });

  test("a missing scripted answer is an observable failed run", () =>
    withAgent(home(), [], async (r) => {
      const answer2 = await r.ask("unscripted");
      expect(answer2).toBe("");
      expect(r.requests).toHaveLength(1);
      expect(r.script.pending()).toBe(0);
      expect(r.agent.history().at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "the script has no answer 1" });
      expect(r.events.at(-1)).toMatchObject({
        type: "agent_settled",
        run: { id: 1, settled: true, failed: true, error: "the script has no answer 1" },
      });
    }));

  test("stops waiting for an ask that is interrupted, and goes on with the run", () => {
    const dir = home();
    const wake = gate();
    let napping = false;
    const nap = textTool({
      name: "nap",
      description: "睡一会",
      parameters: objectSchema(),
      run: async () => {
        napping = true;
        await wake.opened;
        return "醒了";
      },
    });
    return withAgent(
      dir,
      [answer([toolCall("nap", {})]), answer("睡好了")],
      async (r) => {
        const interrupt = new AbortController();
        const asking = r.agent.ask(userMessage("睡", r.clock.now()), interrupt.signal).catch((e: unknown) => e);
        await until(() => napping, "napping");
        interrupt.abort();
        await asking;
        wake.open();
        await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
        expect(messageText(r.agent.history().at(-1)!)).toBe("睡好了");
      },
      { tools: [nap] },
    );
  });

  test("cuts off a run under way when its owner's scope closes", async () => {
    let [started, cut] = [false, false];
    const { llm } = scriptedLLM();
    const asked = (_model: unknown, _context: unknown, _options: unknown, signal?: AbortSignal): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          started = true;
          return new Promise<never>((_, reject) =>
            signal?.addEventListener("abort", () => {
              cut = true;
              reject(signal.reason);
            }),
          );
        },
      }),
    });
    const held = { ...llm, service: { ...llm.service, stream: asked } };
    const clock = testClock();
    const agent = await makeBrain(testBrain(home(), held, { clock }));
    try {
      const now = clock.now();
      await agent.send(userMessage("说", now));
      await until(() => started, "started");
      await agent.close();
      await until(() => cut, "cut");
    } finally {
      await agent.close();
    }
  });

  test("runs a tool and gives its result back", async () => {
    const dir = home();
    writeFileSync(join(dir, "notes.txt"), "第一行\n第二行\n");
    await withAgent(
      dir,
      [
        answer([thinking("先读文件"), toolCall("read_file", { path: "notes.txt" })]),
        step((c) => answer(results(c)[0]?.text.includes("第二行") === true ? "读到了：两行" : "读到了：没读到")),
      ],
      async (r) => {
        const answer2 = await r.ask("看看 notes.txt");
        expect(answer2).toBe("读到了：两行");
        await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
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

  test("tells the model why a tool failed", () => {
    const dir = home();
    writeFileSync(join(dir, "a.txt"), "x x\n");
    return withAgent(
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
      async (r) => expect(await r.ask("改")).toMatch(/^true:old_text 在 a\|true:\S/u),
    );
  });

  test("steers with send and waits with later", () => {
    const dir = home();
    // The nap lasts until the test has said its two lines: they come while the tool runs.
    const wake = gate();
    let napping = false;
    const nap = textTool({
      name: "nap",
      description: "睡一会",
      parameters: objectSchema(),
      run: async () => {
        napping = true;
        await wake.opened;
        return "醒了";
      },
    });
    return withAgent(
      dir,
      [answer([toolCall("nap", {})]), step((c) => answer("第二次听到：" + lastUser(c))), step((c) => answer("第三次听到：" + lastUser(c)))],
      async (r) => {
        const now = r.clock.now();
        await r.agent.send(userMessage("开始", now));
        await until(() => napping, "napping");
        const now2 = r.clock.now();
        await r.agent.later(userMessage("完了再说这个", now2));
        const now3 = r.clock.now();
        await r.agent.send(userMessage("顺便", now3));
        wake.open();
        await until(() => r.agent.history().length >= 7, "r.agent.history().length >= 7");
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

  test("stops at its step limit", () =>
    withAgent(
      home(),
      repeat(4, answer([toolCall("list_dir", {})])),
      async (r) => {
        await r.ask("一直列");
        expect(r.requests.length).toBe(3);
      },
      { maxSteps: 3 },
    ));

  test("goes on with its session when started again", async () => {
    const dir = home();
    const countUsers = step((c) => answer(`第 ${c.messages.filter((m) => m.role === "user").length} 句`));
    await withAgent(dir, [countUsers], async (r) => expect(await r.ask("一")).toBe("第 1 句"));
    await withAgent(dir, [countUsers], async (r) => expect(await r.ask("二")).toBe("第 2 句"));
  });

  test("folds a long conversation", async () => {
    const dir = home();
    const long = step((c) => answer(summarizing(c) ? "摘要：说了五件事" : "好的。".repeat(150)));
    const options = { contextTokens: 900, keepRecent: 2 };
    await withAgent(
      dir,
      repeat(12, long),
      async (r) => {
        for (let n = 1; n <= 5; n++) await r.ask(`第 ${n} 件事`);
        await until(
          () => r.events.some((e) => e.type === "compaction_end" && e.compaction !== undefined),
          'r.events.some((e) => e.type === "compaction_end" && e.compaction !== undefined)',
        );
        const last = r.requests.findLast((c) => !summarizing(c))!;
        expect(messageText(last.messages[0]!)).toMatch(/^【之前的对话压成了下面的摘要，原文在 .*archive.*】\n<summary>\n摘要：说了五件事/u);
        expect(r.agent.history()[0]!.role).toBe("compactionSummary");
      },
      options,
    );
    expect(readdirSync(join(dir, "archive")).length).toBeGreaterThanOrEqual(1);
    await withAgent(
      dir,
      [],
      (r) => {
        const history = r.agent.history();
        expect(history[0]!.role).toBe("compactionSummary");
        expect(history.length).toBeLessThanOrEqual(6);
      },
      options,
    );
  });

  test("lists its skills and reads one", () => {
    const dir = home();
    mkdirSync(join(dir, "skills", "tidy"), { recursive: true });
    writeFileSync(join(dir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: 整理代码时用\n---\n先跑 lint");
    return withAgent(
      dir,
      [answer([toolCall("load_skill", { name: "tidy" })]), step((c) => answer(results(c)[0]!.text.split("\n").at(-1)!))],
      async (r) => {
        const answer2 = await r.ask("整理一下");
        expect(answer2).toBe("先跑 lint");
        expect(systemPrompt(r.requests[0]!)).toContain("- tidy：整理代码时用");
      },
      { noSkills: false, skills: [join(dir, "skills")] },
    );
  });

  test("sends subagents that work side by side", () => {
    const dir = home();
    let running = 0;
    let most = 0;
    const nap = textTool({
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
    return withAgent(
      dir,
      repeat(6, subagentOrNot),
      async (r) => {
        const answer2 = await r.ask("同时查 A 和 B");
        expect(answer2).toBe("查 A 做完了；查 B 做完了");
        expect(most).toBe(2);
      },
      { tools: [nap], reminders: false },
    );
  });

  test("is woken by a reminder that comes due", async () => {
    // Its first look at the reminders is when it opens: by then this one is due.
    const clock = testClock(Date.parse("2026-01-02T00:00:00.000Z"));
    const dir = home();
    writeFileSync(
      join(dir, "reminders.json"),
      `[{"id":"reminder-1","name":"早报","message":"汇总昨天的进展","at":"2026-01-01T00:00:00.000Z","created":"2026-01-01T00:00:00.000Z"}]`,
    );
    await withAgent(
      dir,
      [step((c) => answer("收到：" + lastUser(c)))],
      async (r) => {
        await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
        const history = r.agent.history();
        expect(history[0]!.role).toBe("custom");
        expect(messageText(history[1]!)).toBe("收到：【提醒「早报」到点了（reminder-1）】\n汇总昨天的进展");
      },
      { clock },
    );
    expect(JSON.parse(readFileSync(join(dir, "reminders.json"), "utf8"))).toEqual([]);
  });

  test("is woken when a reminder comes due an hour later, at the exact deadline, not before", async () => {
    const clock = testClock(Date.parse("2026-03-01T08:00:00.000Z"));
    const dir = home();
    writeFileSync(
      join(dir, "reminders.json"),
      `[{"id":"reminder-1","name":"早报","message":"汇总昨天的进展","at":"2026-03-01T09:00:00.000Z","created":"2026-03-01T08:00:00.000Z"}]`,
    );
    await withAgent(
      dir,
      [step((c) => answer("收到：" + lastUser(c)))],
      async (r) => {
        await clock.adjust(60 * 60_000 - 1);
        expect(r.has("agent_start")).toBe(false);
        await clock.adjust(1);
        await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
        expect(messageText(r.agent.history()[1]!)).toBe("收到：【提醒「早报」到点了（reminder-1）】\n汇总昨天的进展");
      },
      { clock },
    );
  });

  test("keeps the same system prompt between folds and tells memory news in the input", () => {
    const dir = home();
    writeFileSync(memoryFile(dir), "- 2026-10-01 用户叫阿周\n- 2026-10-02 用中文\n");
    return withAgent(dir, [answer("一"), answer("二")], async (r) => {
      const memoryNews2 = await r.agent.memoryNews();
      expect(memoryNews2).toBe("");
      await r.ask("a");
      await remember(dir, "用户喜欢短句", new Date(2026, 9, 18, 9).getTime());
      const lines = (await readMemory(dir)).lines;
      await forgetLine(dir, lines.find((l) => l.text === "用中文")!.id);
      const news = await r.agent.memoryNews();
      expect(news).toBe("【记性有更新】\n+ 2026-10-18 用户喜欢短句\n− 2026-10-02 用中文");
      const memoryNews3 = await r.agent.memoryNews();
      expect(memoryNews3).toBe("");
      await r.ask(news + "\n\nb");
      expect(systemPrompt(r.requests[1]!)).toBe(systemPrompt(r.requests[0]!));
      expect(systemPrompt(r.requests[0]!)).toMatch(/用户叫阿周\n- 2026-10-02 用中文$/u);
      expect(lastUser(r.requests[1]!)).toMatch(/^【记性有更新】/u);
      expect(prefixChanges(r)).toEqual([]);
    });
  });

  test("makes the system prompt anew after a fold", () => {
    const dir = home();
    const long = step((c) => answer(summarizing(c) ? "摘要" : "好的。".repeat(150)));
    return withAgent(
      dir,
      repeat(12, long),
      async (r) => {
        await r.ask("第 1 件事");
        const now = r.clock.now();
        await remember(dir, "记在折叠之前", now);
        const folded = () => r.events.some((e) => e.type === "compaction_end" && e.compaction !== undefined);
        for (let n = 2; n <= 5 && !folded(); n++) await r.ask(`第 ${n} 件事`);
        await until(folded, "the history folded");
        await r.ask("折叠之后");
        const prompts = r.requests.filter((c) => !summarizing(c)).map(systemPrompt);
        expect(prompts[0]).not.toContain("记在折叠之前");
        expect(prompts.at(-1)).toContain("记在折叠之前");
        expect(prefixChanges(r)).toEqual([]);
      },
      { contextTokens: 900, keepRecent: 2 },
    );
  });

  test("stops the run under way", () =>
    withAgent(
      home(),
      [answer([text("这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的回答".repeat(20))], { hangAfter: 50 })],
      async (r) => {
        const now = r.clock.now();
        await r.agent.send(userMessage("说", now));
        await until(
          () => r.events.some((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta"),
          'r.events.some((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")',
        );
        await r.agent.stop();
        await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
        expect(settled(r)!.run.aborted).toBe(true);
        const last = r.agent.history().at(-1)!;
        expect(last.role === "assistant" && last.stopReason).toBe("aborted");
      },
    ));

  test("is stopped while a tool runs", () =>
    withAgent(home(), [answer([toolCall("bash", { command: "sleep 5" })])], async (r) => {
      const now = r.clock.now();
      await r.agent.send(userMessage("睡", now));
      await until(() => r.has("tool_execution_start"), 'r.has("tool_execution_start")');
      await r.agent.stop();
      await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
      expect(settled(r)!.run.aborted).toBe(true);
      const last = r.agent.history().at(-1)!;
      expect(last.role).toBe("toolResult");
    }));

  test("reads back a session file", async () => {
    const dir = home();
    const lines = [
      `{"role":"user","content":"一","timestamp":1}`,
      `{"role":"assistant","content":[{"type":"text","text":"好"}],"api":"openai-completions","provider":"deepseek","model":"deepseek-flash","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2,"durationMs":5}`,
      `{"role":"custom","customType":"farmNews","content":"老周做完了","display":false,"timestamp":3}`,
      `{"role":"compactionSummary","summary":"摘要","tokensBefore":900,"timestamp":4,"archive":"/x/archive/orchestrator.md","kept":2}`,
      `{"role":"user","content":"二","timestamp":5}`,
    ];
    writeFileSync(join(dir, "orchestrator.jsonl"), lines.join("\n") + '\n{"role":"us');
    const history = await loadSession(join(dir, "orchestrator.jsonl"));
    expect(said(history)).toEqual(["compactionSummary:摘要", "assistant:好", "custom:老周做完了", "user:二"]);
    expect(history.map((m) => JSON.stringify(m))).toEqual([lines[3], lines[1], lines[2], lines[4]]);
  });

  test("tells a changed tool as a changed prefix", () =>
    withAgent(home(), [answer("一"), answer("二")], async (r) => {
      await r.ask("a");
      await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
      expect(prefixChanges(r)).toEqual([]);
      (r.agent.tools()[0] as { description: string }).description = "改过的说明";
      await r.ask("b");
      await until(() => prefixChanges(r).length > 0, "prefixChanges(r).length > 0");
      expect(prefixChanges(r)[0]).toContain("tools");
    }));

  describe("an idle conversation", () => {
    const idleFoldAfterMs = 50;
    const idleRig = (
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
      return withAgent(dir, repeat(8, reply), (r) => body(r, choices), {
        keepRecent: 2,
        idleFoldAt: 300,
        idleFoldAfterMs,
        ...(wakeSoon ? { wakeSoon } : {}),
      });
    };
    const idleFolded = (r: Rig) => r.events.some((e) => e.type === "compaction_end" && e.reason === "idle" && e.compaction !== undefined);
    /** Lets the idle wait go by until ok holds: the wait is set going after the run settles, on a fiber that may not be
     * asleep yet when the test first moves the clock. */
    const idleUntil = (r: Rig, ok: () => boolean, what: string) =>
      waitFor(
        async () => {
          await r.clock.adjust(idleFoldAfterMs);
          return ok();
        },
        (held) => held,
        what,
      );
    const talk = async (r: Rig) => {
      for (const words of ["一", "二", "三"]) await r.ask(words);
    };

    test("is folded with the same start", () =>
      idleRig(
        undefined,
        () => answer("就地的摘要"),
        async (r, choices) => {
          await talk(r);
          expect(r.requests.length).toBe(3);
          await idleUntil(r, () => idleFolded(r), "idleFolded(r)");
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
      ));

    test("asks again on its own when a tool is called instead of a summary", () =>
      idleRig(
        undefined,
        () => answer([toolCall("list_dir", {})]),
        async (r) => {
          await talk(r);
          await idleUntil(r, () => idleFolded(r), "idleFolded(r)");
          expect((r.agent.history()[0] as CompactionSummaryMessage).summary).toBe("另起的摘要");
        },
      ));

    test("is not folded when it will be woken soon", () => {
      let asked = 0;
      return idleRig(
        (within) => {
          expect(within).toBe(50);
          asked++;
          return true;
        },
        () => answer("摘要"),
        async (r) => {
          await talk(r);
          await idleUntil(r, () => asked > 0, "asked > 0");
          await until(() => !r.agent.busy(), "!r.agent.busy()");
          expect(asked).toBe(1);
          expect(r.requests.length).toBe(3);
          expect(r.agent.history()[0]!.role).toBe("user");
        },
      );
    });
  });

  test("cuts where the last words stay", () => {
    const u = (text: string) => userMessage(text, 1798758000000);
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
    const now = 1798758000000;
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
      test(name, async () => {
        // How old the conversation is, is told by the brain's Clock.
        const clock = testClock(now);
        const dir = home();
        const file = join(dir, "test.jsonl");
        writeFileSync(file, lines.map((m) => JSON.stringify(m)).join("\n") + "\n");
        const sessionUnfinished2 = await sessionUnfinished(file);
        expect(sessionUnfinished2).toBe(isUnfinished);
        await withAgent(
          dir,
          [step((c) => answer(JSON.stringify(results(c))))],
          async (r) => {
            const resumed2 = await r.agent.resume(30 * 60000);
            expect(resumed2).toBe(resumed);
            if (!resumed) {
              // Not resumed: nothing was started to wait for.
              expect(r.requests.length).toBe(0);
              return;
            }
            await until(() => r.has("agent_settled"), 'r.has("agent_settled")');
            expect(r.requests.length).toBe(1);
            expect(results(r.requests[0]!)).toEqual(
              name === "cut off in a tool" ? [{ failed: true, text: resumedUnknown }] : [{ failed: false, text: "（空的）" }],
            );
          },
          { clock },
        );
        if (resumed)
          expect(roles(readFileSync(file, "utf8")).slice(lines.length)).toEqual(name === "cut off in a tool" ? ["toolResult", "assistant"] : ["assistant"]);
      });
  });

  test("drops the tools it is told not to have only after all are assembled", async () => {
    const dir = home();
    const blocked = ["custom", "load_skill", "spawn_agent", "reminder", "list_reminders", "cancel_reminder"];
    await withAgent(
      dir,
      [],
      (r) => {
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
