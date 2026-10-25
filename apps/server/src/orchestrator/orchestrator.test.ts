import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { type AssistantMessage, fauxAssistantMessage, type FauxResponseFactory, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { orchestratorAgent } from "@vibevalley/protocol";
import { messagesIn } from "../channel/state.ts";
import { seedAgents } from "../agent/seed.ts";
import { Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agents } from "../agent/agent.ts";
import { messageText } from "../agent/brain/messages.ts";
import { fauxLLM, type Request } from "../agent/brain/testing.ts";
import type { Config } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Issues } from "../issue/issue.ts";
import { Recurrences } from "../recurrence/recurrence.ts";
import { Notices } from "../notice/notice.ts";
import { Sessions } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { layer, Orchestrator, type OrchestratorShape } from "./orchestrator.ts";
import { deepseekModel, intake, orchestratorModel } from "./rules.ts";
import { untilGot as until } from "../testing/until.ts";

/** Words said to the orchestrator on the phone, as the voice line asks them. */
const onPhone = (o: OrchestratorShape, text: string) => o.answerer("phone")(orchestratorModel)!(text, new AbortController().signal);

const userText = (m: Message) => (m.role === "user" ? messageText(m) : undefined);
const lastInput = (c: Request) =>
  c.messages
    .map(userText)
    .filter((t): t is string => t !== undefined)
    .at(-1) ?? "";
const heads = ["【现在】", "【现状】", "【现状变了】", "【记性有更新】", "这期间田头上的汇报"];
/** An input without what the orchestrator puts before the words. */
const words = (input: string) => {
  const blocks = input.split("\n\n");
  while (blocks.length > 1 && heads.some((h) => blocks[0]!.startsWith(h))) blocks.shift();
  return blocks.join("\n\n");
};
const lastLine = (c: Request) => words(lastInput(c));
const answeredWith = (c: Request) => {
  const last = c.messages.at(-1);
  return last?.role === "toolResult" ? messageText(last) : undefined;
};
const sinceAnswer = (c: Request) => {
  const from = c.messages.findLastIndex((m) => m.role === "assistant") + 1;
  return c.messages
    .slice(from)
    .map(userText)
    .filter((t) => t !== undefined)
    .join("\n");
};

const asked = /加个 (README|CHANGELOG)$/m;

const respond = (c: Request): AssistantMessage => {
  const result = answeredWith(c);
  if (result !== undefined) return fauxAssistantMessage("好，" + [...result].slice(0, 2).join("") + "了");
  const want = asked.exec(sinceAnswer(c))?.[0];
  if (want)
    return fauxAssistantMessage(
      fauxToolCall(
        "issue_create",
        want.includes("CHANGELOG") ? { title: want, project: "notes", agent: "lab", start: true } : { title: want, project: "demo", start: true },
      ),
    );
  if (lastLine(c).includes("定时任务")) return fauxAssistantMessage("到点了，看了一眼");
  return fauxAssistantMessage("收到");
};

const pi = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") });

/** The farm with a orchestrator on the faux model, answering with f; the patrol runs by hand. */
const farm = (f: (c: Request) => AssistantMessage = respond, config: Config = testConfig(), patrolNow?: () => number) => {
  const { faux, llm, requests } = fauxLLM();
  faux.appendResponses(Array.from({ length: 100 }, (): FauxResponseFactory => (context) => f({ messages: context.messages as Message[], options: undefined })));
  const below = world({
    config: { ...config, patrol: { heartbeatMinutes: 0 } },
    runtimes: [pi],
    repos: ["demo", "notes"],
    ...(patrolNow ? { patrolNow } : {}),
  });
  return { requests, layer: layer({ llm: () => llm }).pipe(Layer.provideMerge(below)) };
};

const settle = Effect.sleep(100);

const enableLab = Effect.gen(function* () {
  const agents = yield* Agents;
  const lab = seedAgents().find((a) => a.id === "lab")!;
  yield* agents.saveAgent({ ...lab, enabled: true, effort: "" });
  return lab;
});

const said = Effect.gen(function* () {
  const core = yield* Core;
  const chat = yield* Channels;
  return () =>
    messagesIn(core.state().chat, chat.general())
      .filter((m) => m.from === orchestratorAgent && m.kind === "chat" && m.final)
      .map((m) => m.text);
});

describe("the orchestrator", () => {
  it("takes DeepSeek's models only", () => {
    expect(deepseekModel("", "deepseek-flash")).toBe("deepseek-flash");
    expect(deepseekModel("deepseek/deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(deepseekModel("deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(() => deepseekModel("anthropic/claude", "x")).toThrow(/只接 DeepSeek/);
  });

  it.live("writes an issue down and starts it, and hears the owner's voice in 田头", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* enableLab;
      const words = yield* said;
      yield* orchestrator.say("帮我在 demo 里加个 README", {}, undefined, "");
      expect(yield* until(() => words().length >= 1 && words(), "its words")).toEqual(["好，记下了"]);
      const first = f.requests[0]!;
      expect(lastInput(first)).toMatch(/^【现在】\d{4}\/\d+\/\d+ \d\d:\d\d\n\n【现状】[\s\S]*可以派的帮工：\n- /);
      expect(first.messages[0]!.role === "system" && messageText(first.messages[0]!)).not.toContain("【现状】");
      expect(lastLine(first)).toBe("[来源：主人]\n主人说：帮我在 demo 里加个 README");
      const trail = yield* until(() => {
        const events = (sessions.events(orchestratorAgent) ?? []).filter((e) => e.type !== "llm/usage");
        return events.length >= 6 && events.at(-1)!.type === "run/end" && events;
      }, "its log");
      const [ask, tool, result, answer] = trail.slice(-5, -1);
      expect(result).toMatchObject({ type: "tool/result", call: tool!.seq, ok: true });
      expect(ask!.type).toBe("user/message");
      expect(ask!.text).toMatch(/^\[来源：主人\][\s\S]*加个 README/);
      expect(tool).toMatchObject({ tool: "issue_create", text: "记一张工单：demo" });
      expect(tool!.input).toContain(`"project":"demo"`);
      expect(answer!.text).toBe("好，记下了");
      expect(sessions.roster().map((w) => w.place.project)).toEqual(["demo"]);
      yield* until(() => sessions.roster()[0]?.session.lastRun, "its report");

      const before = f.requests.length;
      yield* orchestrator.heard("随便说一句", "", "");
      yield* until(() => f.requests.length > before, "the orchestrator asked");
      yield* settle;
      expect((yield* until(() => words().length >= 2 && words(), "its words")).at(-1)).toBe("收到");
      expect(messagesIn(core.state().chat, chat.general()).some((m) => m.from === "user" && m.text === "随便说一句" && m.spoken)).toBe(true);
      expect(f.requests.slice(before).filter((c) => lastLine(c).includes("随便说一句")).length).toBe(1);
      expect(lastLine(f.requests.at(-1)!)).toContain("语音那边已经回答了");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("keeps its inputs with where they came from", () => {
    const config = testConfig();
    const f = farm(respond, config);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      expect((yield* Core).state().call).not.toBe("live");
      yield* orchestrator.say("地里怎么样", {}, undefined, "");
      // The owner speaking, from any door, opens the farm.
      expect((yield* Core).state().call).toBe("live");
      yield* until(() => words().length >= 1, "its words");
      const kept = readFileSync(join(config.home, "orchestrator", "orchestrator.jsonl"), "utf8");
      expect(kept).toMatch(/"customType":"orchestratorInput"[^\n]*【现状】/);
      expect(kept).toMatch(/"customType":"orchestratorInput"[^\n]*"source":"owner","owner":true/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("streams its words to a call", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const core = yield* Core;
      const chat = yield* Channels;
      const got = yield* Effect.promise(async () => {
        let out = "";
        for await (const piece of onPhone(orchestrator, "现在地里怎么样")) out += piece;
        return out;
      });
      expect(got).toBe("收到\n");
      expect(lastLine(f.requests.at(-1)!)).toMatch(/主人在电话里说的[\s\S]*主人说：现在地里怎么样/);
      expect(f.requests.length).toBe(1);
      const call = () =>
        messagesIn(core.state().chat, chat.general())
          .filter((m) => m.spoken || m.from === orchestratorAgent)
          .map((m) => m.from + "：" + m.text);
      expect(yield* until(() => call().length === 2 && call(), "the call in 田头")).toEqual(["user：现在地里怎么样", "orchestrator：收到"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A line joining the run ends the brief before it with the words it got: it does not wait for the run's end.
  it.live("ends a brief when another line joins its run", () => {
    const f = farm((c) => {
      const line = lastLine(c);
      if (answeredWith(c) !== undefined) return fauxAssistantMessage("看过了");
      // Slow, so the call's line comes while this run is under way.
      if (line.includes("要告诉主人"))
        return new Promise<AssistantMessage>((r) =>
          setTimeout(() => r(fauxAssistantMessage([{ type: "text", text: "#41 交回来了" }, fauxToolCall("roster", {})])), 300),
        ) as never;
      return respond(c);
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const said = yield* Effect.promise(async () => {
        const brief = orchestrator.brief("【要告诉主人】\n- #41 交回来了");
        await new Promise((r) => setTimeout(r, 100));
        const joined = (async () => {
          for await (const _ of onPhone(orchestrator, "还有别的吗")) void _;
        })();
        const out = await Promise.race([brief, new Promise<string>((_, no) => setTimeout(() => no(new Error("the brief never ended")), 4000))]);
        await joined;
        return out;
      });
      expect(said).toContain("#41 交回来了");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("does not start a brief whose caller already left", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      expect(yield* Effect.promise(() => orchestrator.brief("【要告诉主人】\n- #41 交回来了", AbortSignal.abort()))).toBe("");
      yield* settle;
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("says once why it cannot start", () => {
    const below = world({ config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } } });
    return Effect.gen(function* () {
      const agents = yield* Agents;
      const orchestrator = yield* Orchestrator;
      const core = yield* Core;
      const chat = yield* Channels;
      const me = agents.agent(orchestratorAgent)!;
      yield* agents.saveAgent({ ...me, model: "openai/gpt" });
      const pieces = (text: string) =>
        Effect.promise(async () => {
          const out: string[] = [];
          for await (const piece of onPhone(orchestrator, text)) out.push(piece);
          return out;
        });
      const first = yield* pieces("在吗");
      expect(first.length).toBe(1);
      expect(first[0]).toContain("只接 DeepSeek");
      const refusal = () => messagesIn(core.state().chat, chat.general()).filter((m) => m.from === orchestratorAgent);
      expect((yield* until(() => refusal()[0], "the refusal on 田头")).text).toMatch(/^我这边起不来：/);
      expect((yield* pieces("还在吗")).length).toBe(1);
      yield* settle;
      expect(refusal().length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer().pipe(Layer.provideMerge(below))));
  });

  it.live("hears a send key once", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      for (let i = 0; i < 2; i++) yield* orchestrator.say("地里怎么样", {}, undefined, "k1");
      for (let i = 0; i < 2; i++) yield* orchestrator.heard("电话里问一句", "", "k2");
      yield* until(() => words().length >= 2, "its words");
      yield* settle;
      const heard = { 地里怎么样: 0, 电话里问一句: 0 };
      for (const m of f.requests.at(-1)!.messages) {
        const text = userText(m);
        if (text === undefined) continue;
        for (const k of Object.keys(heard) as (keyof typeof heard)[]) if (text.includes(k)) heard[k]++;
      }
      expect(heard).toEqual({ 地里怎么样: 1, 电话里问一句: 1 });
      expect(yield* Effect.flip(orchestrator.say("早", {}, undefined, "k".repeat(65)))).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A seed sown from the farm's form carries its profile and project: the orchestrator is told both, beside the words.
  it.live("is told the sowing form's pick", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const lab = yield* enableLab;
      const words = yield* said;
      yield* orchestrator.say("修一个 bug：登录闪退", { agent: lab.id, project: " notes " }, undefined, "");
      yield* until(() => words().length >= 1, "its words");
      expect(lastLine(f.requests[0]!)).toMatch(
        new RegExp(`（主人在对话框里选定了帮工：${lab.name}）\n（主人选定了项目：notes，派活就派在这个项目里）\n主人说：修一个 bug：登录闪退$`),
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("hears a long report cut", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const core = yield* Core;
      const chat = yield* Channels;
      const lab = yield* enableLab;
      const hired = yield* issues.hire({ ...lab, enabled: true, effort: "" }, "写一份长汇报", "notes");
      const id = hired.session!.id;
      yield* until(() => core.state().chat?.messages.some((m) => m.from === id && m.kind === "report"), "its report");
      const spoken = yield* chat.speak(id, "@管家 " + "长".repeat(5000), { anyway: true });
      expect(spoken.kind).toBe("sent");
      const line = yield* until(() => f.requests.map(lastLine).find((l) => l.startsWith(intake.chat.head + "【田头】")), "the orchestrator asked");
      expect(line).not.toContain("长".repeat(797));
      expect(line).toContain("@管家 " + "长".repeat(796) + "…（这条有 5004 字，全文用 read_chat 读 " + spoken.target + "）");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("completes an issue only when the owner asks, and says what it delivered", () => {
    let helper = "";
    let number = 0;
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return fauxAssistantMessage("合并：" + result);
      const line = lastLine(c);
      // A helper's words name it by its name; the owner's, by the issue's number.
      if (line.includes("直接收")) return fauxAssistantMessage(fauxToolCall("issue_status", { issue: helper, to: "已完成" }));
      if (line.includes("收下")) return fauxAssistantMessage(fauxToolCall("issue_status", { issue: "#" + number, to: "已完成" }));
      return respond(c);
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const chat = yield* Channels;
      const orchestrator = yield* Orchestrator;
      const lab = yield* enableLab;
      const hired = yield* issues.hire({ ...lab, enabled: true, effort: "" }, "写个 hello", "notes");
      helper = hired.session!.id;
      number = (yield* issues.get(hired.session!.issue!)).number;
      yield* until(() => sessions.roster().some((r) => r.session.id === helper && r.session.phase._tag === "done"), "the work handed back");
      yield* chat.speak(helper, "@管家 主人同意了，直接收", { anyway: true });
      const thread = (yield* chat.jobThread(helper))!;
      const refused = yield* until(
        () => messagesIn(core.state().chat, thread).find((m) => m.from === orchestratorAgent && m.final && m.text.startsWith("合并：")),
        "the completion refused",
      );
      expect(refused.text).toBe("合并：没动：改工单、挪状态要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要这样做。");
      expect((yield* issues.get(hired.session!.issue!)).closedAt).toBeUndefined();
      yield* orchestrator.say("收下", {}, undefined, "");
      const merged = yield* Effect.promise(async () => {
        for (let i = 0; i < 500; i++) {
          const t = await Effect.runPromise(issues.get(hired.session!.issue!));
          if (t.closedAt !== undefined) return t;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never merged");
      });
      // The helper said its words and committed nothing: done, with nothing to merge, and said so.
      expect(merged.delivered).toBe("none");
      const general = (yield* Channels).general();
      yield* until(
        () => messagesIn(core.state().chat, general).some((m) => m.from === orchestratorAgent && m.final && m.text === `合并：#${number} 已完成，没有改动要合`),
        "what it delivered said",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // The owner's words name issues by number: noted down without anyone sent, started on the owner's say, found again
  // among those waiting on the owner.
  it.live("works in issues", () => {
    let number = 0;
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return fauxAssistantMessage("工单：" + result);
      const line = lastLine(c);
      if (line.includes("记一下")) return fauxAssistantMessage(fauxToolCall("issue_create", { title: "首页偶尔白屏", project: "demo", agent: "lab" }));
      if (line.includes("开工")) return fauxAssistantMessage(fauxToolCall("issue_status", { issue: "#" + number, to: "待办" }));
      if (line.includes("在等我")) return fauxAssistantMessage(fauxToolCall("issues", { wants_owner: true }));
      return respond(c);
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      yield* enableLab;
      yield* orchestrator.say("记一下：首页偶尔白屏", {}, undefined, "");
      const noted = yield* until(() => words().find((w) => w.startsWith("工单：记下了")), "noted");
      const issue = (yield* issues.list()).find((t) => t.title === "首页偶尔白屏")!;
      number = issue.number;
      expect(noted).toBe(`工单：记下了：#${number}「首页偶尔白屏」，在备选里，没开工`);
      expect([issue.status, issue.sessions]).toEqual(["backlog", []]);
      yield* orchestrator.say(`#${number} 开工`, {}, undefined, "");
      yield* until(() => words().some((w) => w.startsWith("工单：挪好了")), "started");
      yield* Effect.promise(async () => {
        for (let i = 0; i < 500; i++) {
          if ((await Effect.runPromise(issues.get(issue.id))).status === "in_review") return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never handed back");
      });
      yield* orchestrator.say("哪些在等我？", {}, undefined, "");
      const waiting = yield* until(() => words().find((w) => w.startsWith("工单：- #")), "listed");
      expect(waiting).toContain(`#${number}「首页偶尔白屏」等你验收`);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("lets a recurrence it sets unasked wait for the owner", () => {
    const daily = { name: "每日测试", text: "跑一遍测试", kind: "daily", time: "09:00" };
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return fauxAssistantMessage("定时：" + result);
      const line = lastLine(c);
      if (line.includes("每天九点") || line.includes("定时任务")) return fauxAssistantMessage(fauxToolCall("recurrence", daily));
      return respond(c);
    });
    return Effect.gen(function* () {
      const recurrences = yield* Recurrences;
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      // Woken by a recurrence, not the owner: what it sets to come back daily waits.
      yield* recurrences.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, "owner", true);
      yield* Effect.sleep(80);
      yield* recurrences.tick;
      yield* until(() => words().some((w) => w.startsWith("定时：定好了，等主人同意才生效")), "the orchestrator told it waits");
      const mine = (enabled: boolean) => recurrences.list().filter((s) => s.name === "每日测试" && s.enabled === enabled);
      expect(mine(false)).toMatchObject([{ pending: true, by: "orchestrator" }]);
      yield* orchestrator.say("每天九点跑一遍测试", {}, undefined, "");
      const on = yield* until(() => mine(true).length === 1 && mine(true), "the owner's recurrence on");
      expect(on[0]).toMatchObject({ by: "orchestrator" });
      expect(on[0]!.pending ?? false).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // However its turn ends, the orchestrator's issue waits on the owner: a turn that did not fail is not an answer taken.
  it.live("leaves its issue for the owner to take as done", () => {
    const f = farm();
    return Effect.gen(function* () {
      const recurrences = yield* Recurrences;
      const issues = yield* Issues;
      const s = yield* recurrences.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, "owner", true);
      yield* Effect.sleep(80);
      yield* recurrences.tick;
      const core = yield* Core;
      const handed = yield* until(() => core.state().issues?.find((t) => t.recurrence === s.id && t.status === "in_review"), "handed back");
      const id = handed.id;
      expect(handed.closedAt).toBeUndefined();
      expect([handed.deliver, handed.lastRun?.outcome]).toEqual(["answer", "completed"]);
      expect(handed.attention).toMatchObject({ state: "reviewing", lead: "acknowledge" });
      // One table whoever did the work: asked again (todo), taken (done), or put away (canceled).
      expect(handed.moves).toEqual(["todo", "done", "canceled"]);
      const done = yield* issues.setStatus(id, "done", "", "");
      expect([done.status, done.delivered]).toEqual(["done", "none"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("hears the patrol once", () => {
    let offset = 0;
    const f = farm(respond, testConfig(), () => Date.now() + offset);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const notices = yield* Notices;
      const sessions = yield* Sessions;
      yield* enableLab;
      yield* orchestrator.say("帮我在 notes 里加个 CHANGELOG", {}, undefined, "");
      yield* until(() => sessions.roster().some((r) => r.session.brief === "加个 CHANGELOG" && r.session.phase._tag === "done"), "the work handed back");
      const patrolLine = /^\[来源：巡查\]\n【巡查】[\s\S]*「加个 CHANGELOG」/;
      yield* notices.patrol;
      yield* settle;
      expect(f.requests.some((c) => lastLine(c).includes("【巡查】"))).toBe(false);
      offset = 3 * 3_600_000;
      yield* notices.patrol;
      const line = yield* until(() => f.requests.map(lastLine).find((l) => patrolLine.test(l)), "the patrol's news");
      expect(line).toMatch(/^\[来源：巡查\]\n【巡查】#田头 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没人看：「加个 CHANGELOG」/);
      offset = 3.5 * 3_600_000;
      yield* notices.patrol;
      yield* settle;
      // Each request carries the whole conversation: count this work's patrol lines in the latest.
      const latest = f.requests.at(-1)!;
      expect(latest.messages.filter((m) => patrolLine.test(words(userText(m) ?? ""))).length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("saves a turn the owner marks wrong as a case", () => {
    const config = testConfig();
    const f = farm(respond, config);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const sessions = yield* Sessions;
      const words = yield* said;
      yield* orchestrator.say("地里怎么样", {}, undefined, "");
      yield* until(() => words().length >= 1, "its words");
      const asked = yield* until(() => (sessions.events(orchestratorAgent) ?? []).find((e) => e.type === "user/message"), "its log");
      const made = yield* orchestrator.markWrong(asked.seq, "应该先看一眼地里");
      const saved = JSON.parse(readFileSync(made.file, "utf8")) as { want: string; input: { customType: string }; did: { role: string }[]; tools: string[] };
      expect(saved.want).toBe("应该先看一眼地里");
      expect(saved.input.customType).toBe("orchestratorInput");
      expect(saved.did.map((m) => m.role)).toContain("assistant");
      expect(saved.tools).toContain("issue_create");
      expect(saved.tools).toContain("remember");
      expect(yield* Effect.flip(orchestrator.markWrong(9_999, "x"))).toMatchObject({ _tag: "Missing" });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
