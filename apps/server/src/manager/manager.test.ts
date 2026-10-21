import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { type AssistantMessage, fauxAssistantMessage, type FauxResponseFactory, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { managerAgent } from "@vibevalley/protocol";
import { messagesIn, seedAgents } from "@vibevalley/protocol/rules";
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
import { Schedules } from "../schedule/schedule.ts";
import { Notices } from "../notice/notice.ts";
import { Sessions } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { layer, Manager } from "./manager.ts";
import { deepseekModel, sourceHead } from "./rules.ts";

const userText = (m: Message) => (m.role === "user" ? messageText(m) : undefined);
const lastInput = (c: Request) =>
  c.messages
    .map(userText)
    .filter((t): t is string => t !== undefined)
    .at(-1) ?? "";
const heads = ["【现在】", "【农场现状】", "【农场变了】", "【记性有更新】", "这期间田头上的汇报"];
/** An input without what the manager puts before the words. */
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
      fauxToolCall("dispatch", want.includes("CHANGELOG") ? { brief: want, project: "notes", agent: "lab" } : { brief: want, project: "demo" }),
    );
  if (lastLine(c).includes("定时任务")) return fauxAssistantMessage("到点了，看了一眼");
  return fauxAssistantMessage("收到");
};

const pi = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") });

/** The farm with a manager on the faux model, answering with f; the patrol runs by hand. */
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

const until = <A>(get: () => A | undefined | false, what: string, ms = 5_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = get();
      if (got) return got;
      if (Date.now() > deadline) throw new Error(`waited for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  });
const settle = Effect.promise(() => new Promise((r) => setTimeout(r, 100)));

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
      .filter((m) => m.from === managerAgent && m.kind === "chat" && m.final)
      .map((m) => m.text);
});

describe("the manager", () => {
  it("takes DeepSeek's models only", () => {
    expect(deepseekModel("", "deepseek-flash")).toBe("deepseek-flash");
    expect(deepseekModel("deepseek/deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(deepseekModel("deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(() => deepseekModel("anthropic/claude", "x")).toThrow(/只接 DeepSeek/);
  });

  it.live("dispatches, and hears the owner's voice in 田头", () => {
    const f = farm();
    return Effect.gen(function* () {
      const manager = yield* Manager;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const chat = yield* Channels;
      yield* enableLab;
      const words = yield* said;
      yield* manager.say("帮我在 demo 里加个 README", {}, undefined, "");
      expect(yield* until(() => words().length >= 1 && words(), "its words")).toEqual(["好，已在了"]);
      const first = f.requests[0]!;
      expect(lastInput(first)).toMatch(/^【现在】\d{4}\/\d+\/\d+ \d\d:\d\d\n\n【农场现状】[\s\S]*可以派的帮工：\n- /);
      expect(first.messages[0]!.role === "system" && messageText(first.messages[0]!)).not.toContain("【农场现状】");
      expect(lastLine(first)).toBe("[来源：主人]\n主人说：帮我在 demo 里加个 README");
      const trail = yield* until(() => {
        const events = (sessions.events(managerAgent) ?? []).filter((e) => e.type !== "llm/usage");
        return events.length >= 6 && events.at(-1)!.type === "run/end" && events;
      }, "its log");
      const [ask, tool, result, answer] = trail.slice(-5, -1);
      expect(result).toMatchObject({ type: "tool/result", call: tool!.seq, ok: true });
      expect(ask!.type).toBe("user/message");
      expect(ask!.text).toMatch(/^\[来源：主人\][\s\S]*加个 README/);
      expect(tool).toMatchObject({ tool: "dispatch", text: "派活：demo" });
      expect(tool!.input).toContain(`"project":"demo"`);
      expect(answer!.text).toBe("好，已在了");
      expect(sessions.roster().map((w) => w.place.project)).toEqual(["demo"]);
      yield* until(() => sessions.roster()[0]?.session.lastRun, "its report");

      const before = f.requests.length;
      yield* manager.heard("随便说一句", "", "");
      yield* until(() => f.requests.length > before, "the manager asked");
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
      const manager = yield* Manager;
      const words = yield* said;
      yield* manager.say("地里怎么样", {}, undefined, "");
      yield* until(() => words().length >= 1, "its words");
      const kept = readFileSync(join(config.home, "manager", "manager.jsonl"), "utf8");
      expect(kept).toMatch(/"customType":"managerInput"[^\n]*【农场现状】/);
      expect(kept).toMatch(/"customType":"managerInput"[^\n]*"source":"owner","owner":true/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("streams its words to a call", () => {
    const f = farm();
    return Effect.gen(function* () {
      const manager = yield* Manager;
      const core = yield* Core;
      const chat = yield* Channels;
      const got = yield* Effect.promise(async () => {
        let out = "";
        for await (const piece of manager.call("现在地里怎么样")) out += piece;
        return out;
      });
      expect(got).toBe("收到\n");
      expect(lastLine(f.requests.at(-1)!)).toMatch(/主人在电话里说的[\s\S]*主人说：现在地里怎么样/);
      expect(f.requests.length).toBe(1);
      const call = () =>
        messagesIn(core.state().chat, chat.general())
          .filter((m) => m.spoken || m.from === managerAgent)
          .map((m) => m.from + "：" + m.text);
      expect(yield* until(() => call().length === 2 && call(), "the call in 田头")).toEqual(["user：现在地里怎么样", "manager：收到"]);
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
      const manager = yield* Manager;
      const said = yield* Effect.promise(async () => {
        const brief = manager.brief("【要告诉主人】\n- #41 交回来了");
        await new Promise((r) => setTimeout(r, 100));
        const joined = (async () => {
          for await (const _ of manager.call("还有别的吗")) void _;
        })();
        const out = await Promise.race([brief, new Promise<string>((_, no) => setTimeout(() => no(new Error("the brief never ended")), 4000))]);
        await joined;
        return out;
      });
      expect(said).toContain("#41 交回来了");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("says once why it cannot start", () => {
    const below = world({ config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } } });
    return Effect.gen(function* () {
      const agents = yield* Agents;
      const manager = yield* Manager;
      const core = yield* Core;
      const chat = yield* Channels;
      const me = agents.agent(managerAgent)!;
      yield* agents.saveAgent({ ...me, model: "openai/gpt" });
      const pieces = (text: string) =>
        Effect.promise(async () => {
          const out: string[] = [];
          for await (const piece of manager.call(text)) out.push(piece);
          return out;
        });
      const first = yield* pieces("在吗");
      expect(first.length).toBe(1);
      expect(first[0]).toContain("只接 DeepSeek");
      const refusal = () => messagesIn(core.state().chat, chat.general()).filter((m) => m.from === managerAgent);
      expect((yield* until(() => refusal()[0], "the refusal on 田头")).text).toMatch(/^我这边起不来：/);
      expect((yield* pieces("还在吗")).length).toBe(1);
      yield* settle;
      expect(refusal().length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer().pipe(Layer.provideMerge(below))));
  });

  it.live("hears a send key once", () => {
    const f = farm();
    return Effect.gen(function* () {
      const manager = yield* Manager;
      const words = yield* said;
      for (let i = 0; i < 2; i++) yield* manager.say("地里怎么样", {}, undefined, "k1");
      for (let i = 0; i < 2; i++) yield* manager.heard("电话里问一句", "", "k2");
      yield* until(() => words().length >= 2, "its words");
      yield* settle;
      const heard = { 地里怎么样: 0, 电话里问一句: 0 };
      for (const m of f.requests.at(-1)!.messages) {
        const text = userText(m);
        if (text === undefined) continue;
        for (const k of Object.keys(heard) as (keyof typeof heard)[]) if (text.includes(k)) heard[k]++;
      }
      expect(heard).toEqual({ 地里怎么样: 1, 电话里问一句: 1 });
      expect(yield* Effect.flip(manager.say("早", {}, undefined, "k".repeat(65)))).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A seed sown from the farm's form carries its profile and project: the manager is told both, beside the words.
  it.live("is told the sowing form's pick", () => {
    const f = farm();
    return Effect.gen(function* () {
      const manager = yield* Manager;
      const lab = yield* enableLab;
      const words = yield* said;
      yield* manager.say("修一个 bug：登录闪退", { agent: lab.id, project: " notes " }, undefined, "");
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
      const line = yield* until(() => f.requests.map(lastLine).find((l) => l.startsWith(sourceHead("chat") + "【田头】")), "the manager asked");
      expect(line).not.toContain("长".repeat(797));
      expect(line).toContain("@管家 " + "长".repeat(796) + "…（这条有 5004 字，全文用 read_chat 读 " + spoken.target + "）");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("merges only when the owner asks", () => {
    let helper = "";
    let number = 0;
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return fauxAssistantMessage("合并：" + result);
      const line = lastLine(c);
      // A helper's words name it by its name; the owner's, by the issue's number.
      if (line.includes("直接 merge")) return fauxAssistantMessage(fauxToolCall("merge", { issue: helper }));
      if (line.includes("收下")) return fauxAssistantMessage(fauxToolCall("merge", { issue: "#" + number }));
      return respond(c);
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const chat = yield* Channels;
      const manager = yield* Manager;
      const lab = yield* enableLab;
      const hired = yield* issues.hire({ ...lab, enabled: true, effort: "" }, "写个 hello", "notes");
      helper = hired.session!.id;
      number = (yield* issues.get(hired.session!.issue!)).number;
      yield* until(() => sessions.roster().some((r) => r.session.id === helper && r.session.phase._tag === "ripe"), "the work ripe");
      yield* chat.speak(helper, "@管家 主人同意了，直接 merge", { anyway: true });
      const thread = (yield* chat.jobThread(helper))!;
      const refused = yield* until(
        () => messagesIn(core.state().chat, thread).find((m) => m.from === managerAgent && m.final && m.text.startsWith("合并：")),
        "the merge refused",
      );
      expect(refused.text).toBe("合并：没合：合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。");
      expect((yield* issues.get(hired.session!.issue!)).closed).toBeUndefined();
      yield* manager.say("收下", {}, undefined, "");
      const merged = yield* Effect.promise(async () => {
        for (let i = 0; i < 500; i++) {
          const t = await Effect.runPromise(issues.get(hired.session!.issue!));
          if (t.closed) return t;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never merged");
      });
      expect(merged.closed).toBe("merged");
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
      const manager = yield* Manager;
      const words = yield* said;
      yield* enableLab;
      yield* manager.say("记一下：首页偶尔白屏", {}, undefined, "");
      const noted = yield* until(() => words().find((w) => w.startsWith("工单：记下了")), "noted");
      const issue = (yield* issues.list()).find((t) => t.title === "首页偶尔白屏")!;
      number = issue.number;
      expect(noted).toBe(`工单：记下了：#${number}「首页偶尔白屏」，在备选里`);
      expect([issue.status, issue.sessions]).toEqual(["backlog", []]);
      yield* manager.say(`#${number} 开工`, {}, undefined, "");
      yield* until(() => words().some((w) => w.startsWith("工单：挪好了")), "started");
      yield* Effect.promise(async () => {
        for (let i = 0; i < 500; i++) {
          if ((await Effect.runPromise(issues.get(issue.id))).status === "in_review") return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("never handed back");
      });
      yield* manager.say("哪些在等我？", {}, undefined, "");
      const waiting = yield* until(() => words().find((w) => w.startsWith("工单：- #")), "listed");
      expect(waiting).toContain(`#${number}「首页偶尔白屏」等你验收`);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("lets a schedule it sets unasked wait for the owner", () => {
    const daily = { name: "每日测试", text: "跑一遍测试", kind: "daily", time: "09:00" };
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return fauxAssistantMessage("定时：" + result);
      const line = lastLine(c);
      if (line.includes("每天九点") || line.includes("定时任务")) return fauxAssistantMessage(fauxToolCall("schedule", daily));
      return respond(c);
    });
    return Effect.gen(function* () {
      const schedules = yield* Schedules;
      const manager = yield* Manager;
      const words = yield* said;
      // Woken by a schedule, not the owner: what it sets to come back daily waits.
      yield* schedules.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, "owner", true);
      yield* Effect.sleep(80);
      yield* schedules.tick;
      yield* until(() => words().some((w) => w.startsWith("定时：定好了，等主人同意才生效")), "the manager told it waits");
      const mine = (enabled: boolean) => schedules.list().filter((s) => s.name === "每日测试" && s.enabled === enabled);
      expect(mine(false)).toMatchObject([{ pending: true, by: "manager" }]);
      yield* manager.say("每天九点跑一遍测试", {}, undefined, "");
      const on = yield* until(() => mine(true).length === 1 && mine(true), "the owner's schedule on");
      expect(on[0]).toMatchObject({ by: "manager" });
      expect(on[0]!.pending ?? false).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // However its turn ends, the manager's issue waits on the owner: a turn that did not fail is not an answer taken.
  it.live("leaves its issue for the owner to take as done", () => {
    const f = farm();
    return Effect.gen(function* () {
      const schedules = yield* Schedules;
      const issues = yield* Issues;
      const s = yield* schedules.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, "owner", true);
      yield* Effect.sleep(80);
      yield* schedules.tick;
      const core = yield* Core;
      const handed = yield* until(() => core.state().issues?.find((t) => t.schedule === s.id && t.status === "in_review"), "handed back");
      const id = handed.id;
      expect(handed.closed).toBeUndefined();
      expect(handed.handedBack?.outcome).toBe("completed");
      expect(handed.standing).toMatchObject({ state: "reviewing", lead: "acknowledge" });
      expect(handed.moves).toEqual(["done", "canceled"]);
      const done = yield* issues.setStatus(id, "done", "", "");
      expect([done.status, done.closed]).toEqual(["done", "answered"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("hears the patrol once", () => {
    let offset = 0;
    const f = farm(respond, testConfig(), () => Date.now() + offset);
    return Effect.gen(function* () {
      const manager = yield* Manager;
      const notices = yield* Notices;
      const sessions = yield* Sessions;
      yield* enableLab;
      yield* manager.say("帮我在 notes 里加个 CHANGELOG", {}, undefined, "");
      yield* until(() => sessions.roster().some((r) => r.session.brief === "加个 CHANGELOG" && r.session.phase._tag === "ripe"), "the work ripe");
      const patrolLine = /^\[来源：巡查\]\n【巡查】[\s\S]*「加个 CHANGELOG」/;
      yield* notices.patrol;
      yield* settle;
      expect(f.requests.some((c) => lastLine(c).includes("【巡查】"))).toBe(false);
      offset = 3 * 3_600_000;
      yield* notices.patrol;
      const line = yield* until(() => f.requests.map(lastLine).find((l) => patrolLine.test(l)), "the patrol's news");
      expect(line).toMatch(/^\[来源：巡查\]\n【巡查】#田头 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没收：「加个 CHANGELOG」/);
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
      const manager = yield* Manager;
      const sessions = yield* Sessions;
      const words = yield* said;
      yield* manager.say("地里怎么样", {}, undefined, "");
      yield* until(() => words().length >= 1, "its words");
      const asked = yield* until(() => (sessions.events(managerAgent) ?? []).find((e) => e.type === "user/message"), "its log");
      const made = yield* manager.markWrong(asked.seq, "应该先看一眼地里");
      const saved = JSON.parse(readFileSync(made.file, "utf8")) as { want: string; input: { customType: string }; did: { role: string }[]; tools: string[] };
      expect(saved.want).toBe("应该先看一眼地里");
      expect(saved.input.customType).toBe("managerInput");
      expect(saved.did.map((m) => m.role)).toContain("assistant");
      expect(saved.tools).toContain("dispatch");
      expect(saved.tools).toContain("remember");
      expect(yield* Effect.flip(manager.markWrong(9_999, "x"))).toMatchObject({ _tag: "Missing" });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
