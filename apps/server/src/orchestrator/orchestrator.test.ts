import { scriptedRuntime } from "@botiverse/oar/testing";
import type { EvalCase } from "./evals.ts";
import { owner } from "@/base/actor.ts";
import { describe, expect, it } from "@effect/vitest";
import type { Message } from "@vibevalley/ai/messages";
import { type Answer, answer, toolCall } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { Said } from "@/testing/said.ts";
import { starter } from "@/testing/layers.ts";
import { Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agents } from "@/agent/agent.ts";
import { messageText } from "@vibevalley/agent/messages";
import { type Reply, type Request, scriptedLLM } from "@vibevalley/agent/testing";
import type { ServerConfig } from "@/base/config.ts";
import { Channels } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { Issues } from "@/issue/issue.ts";
import { Crons } from "@/cron/cron.ts";
import { Notices } from "@/notice/notice.ts";
import { Sessions } from "@/session/session.ts";
import { testConfig } from "@/testing/layers.ts";
import { world } from "@/testing/world.ts";
import { Orchestrator } from "./orchestrator.ts";
import { deepseekModel, intake, orchestratorModel } from "./rules.ts";
import { gate, untilGot as until, whenTrue, within } from "@/testing/until.ts";

/** Words said to the orchestrator on the phone, as the voice line asks them. */
const onPhone = (o: Orchestrator["Service"], text: string) => o.answerer("phone")(orchestratorModel)!(text, new AbortController().signal);

const userText = (m: Message) => (m.role === "user" ? messageText(m) : undefined);
const lastInput = (c: Request) =>
  c.messages
    .map(userText)
    .filter((t): t is string => t !== undefined)
    .at(-1) ?? "";
const heads = ["【现在】", "【现状】", "【现状变了】", "【记性有更新】", "这期间群聊里的汇报"];
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

const respond = (c: Request): Answer => {
  const result = answeredWith(c);
  if (result !== undefined) return answer("好，" + [...result].slice(0, 2).join("") + "了");
  const want = asked.exec(sinceAnswer(c))?.[0];
  if (want)
    return answer([
      toolCall(
        "issue_create",
        want.includes("CHANGELOG") ? { title: want, project: "notes", assignee: "lab", start: true } : { title: want, project: "demo", start: true },
      ),
    ]);
  if (lastLine(c).includes("定时任务")) return answer("到点了，看了一眼");
  return answer("收到");
};

const pi = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") });

/** The patrol runs by hand: heartbeatMinutes 0 leaves nothing to the timer. */
const farm = (f: Reply = respond, config: ServerConfig["Service"] = testConfig(), clock?: () => number) => {
  const { llm, requests } = scriptedLLM(Array.from({ length: 100 }, () => f));
  const below = world({
    config: { ...config, patrol: { heartbeatMinutes: 0 } },
    runtimes: [pi],
    repos: ["demo", "notes"],
    ...(clock ? { clock } : {}),
  });
  return { requests, layer: Orchestrator.layer({ llm: () => llm }).pipe(Layer.provideMerge(below)) };
};

/** Everything handed to the orchestrator before this is taken once this is: it takes one input at a time. So a test that
 * says nothing more came of something waits for this, not for a while. */
const marked = (f: { readonly requests: readonly Request[] }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const before = f.requests.length;
    yield* orchestrator.say("（标记）", {}, undefined, "");
    yield* until(() => f.requests.slice(before).some((c) => lastLine(c).includes("（标记）")), "the marker taken");
  });

const enableLab = Effect.gen(function* () {
  const agents = yield* Agents;
  const lab = starter("lab");
  yield* agents.save({ ...lab, enabled: true, effort: "" });
  return lab;
});

const said = Effect.gen(function* () {
  const { in: saidIn } = yield* Said;
  const chat = yield* Channels;
  return () =>
    saidIn(chat.defaultChannel())
      .filter((m) => m.from === defaultOrchestrator && m.kind === "chat")
      .map((m) => m.text);
});

describe("the orchestrator", () => {
  it("takes DeepSeek's models only", () => {
    expect(deepseekModel("", "deepseek-flash")).toBe("deepseek-flash");
    expect(deepseekModel("deepseek/deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(deepseekModel("deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(() => deepseekModel("anthropic/claude", "x")).toThrow(/只接 DeepSeek/);
  });

  it.live("writes an issue down and starts it, and hears the owner's voice in the default channel", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const sessions = yield* Sessions;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channels;
      yield* enableLab;
      const words = yield* said;
      yield* orchestrator.say("帮我在 demo 里加个 README", {}, undefined, "");
      expect(yield* until(() => words().length >= 1 && words(), "its words")).toEqual(["好，记下了"]);
      const first = f.requests[0]!;
      expect(lastInput(first)).toMatch(/^【现在】\d{4}\/\d+\/\d+ \d\d:\d\d\n\n【现状】[\s\S]*可以派的帮工：\n- /);
      expect(first.system).not.toContain("【现状】");
      expect(lastLine(first)).toBe("[来源：主人]\n主人说：帮我在 demo 里加个 README");
      const trail = yield* until(() => {
        const events = (sessions.events(defaultOrchestrator) ?? []).filter((e) => e.type !== "llm/usage");
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
      expect((yield* until(() => words().length >= 2 && words(), "its words")).at(-1)).toBe("收到");
      const answered = f.requests.length;
      yield* marked(f);
      expect(saidIn(chat.defaultChannel()).some((m) => m.from === "owner" && m.text === "随便说一句" && m.spoken)).toBe(true);
      expect(f.requests.slice(before).filter((c) => lastLine(c).includes("随便说一句")).length).toBe(1);
      expect(lastLine(f.requests[answered - 1]!)).toContain("语音那边已经回答了");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("answers the owner in their direct channel", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channels;
      const direct = (yield* Core).state().chat!.channels.find((c) => c.type === "direct" && c.peer === defaultOrchestrator)!;
      yield* orchestrator.say("单独问你一句：地里怎么样", {}, direct.id, "");
      const answered = () => saidIn(direct.id).filter((m) => m.from === defaultOrchestrator);
      expect((yield* until(() => answered().length >= 1 && answered(), "its answer there")).map((m) => m.text)).toEqual(["收到"]);
      expect(saidIn(chat.defaultChannel()).some((m) => m.from === defaultOrchestrator)).toBe(false);
      const asked = f.requests.at(-1)!;
      expect(lastLine(asked)).toBe("[来源：主人]\n主人说：单独问你一句：地里怎么样");
      expect(lastInput(asked)).toContain("你正在回话的地方：和主人的私聊 @owner");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("several orchestrators: each answers in its own direct channel, the channels it looks after and where it is named", () => {
    const config = testConfig();
    const f = farm(respond, config);
    return Effect.gen(function* () {
      const agents = yield* Agents;
      const issues = yield* Issues;
      const orchestrator = yield* Orchestrator;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channels;
      const lead = yield* agents.create({ ...agents.agent(defaultOrchestrator)!, id: "", name: "阿青", persona: "你专管 notes。" });
      const from = (channel: string, who: string) => saidIn(channel).filter((m) => m.from === who && m.kind === "chat");
      const asked = (text: string) => f.requests.filter((c) => lastLine(c).includes(text));

      const direct = yield* issues.talkWith(lead.name);
      expect(direct).not.toBe(chat.orchestratorDirect(defaultOrchestrator));
      yield* orchestrator.say("私下问你", {}, direct, "");
      expect((yield* until(() => from(direct, lead.id)[0], "its answer in its direct channel")).name).toBe("阿青");
      expect(asked("私下问你")[0]!.system).toContain("你是管家「阿青」");
      expect(readFileSync(join(config.home, "agent", lead.id, `${lead.id}.jsonl`), "utf8")).toContain("私下问你");

      const notes = (yield* chat.openChannel("notes-room", "", "")).id;
      yield* chat.updateChannel(notes, { orchestrator: lead.id });
      expect(chat.orchestratorOf(notes)).toBe(lead.id);
      yield* orchestrator.say("这边怎么样", {}, notes, "");
      yield* until(() => from(notes, lead.id)[0], "the answer from the one that looks after the channel");
      yield* orchestrator.say(`@${lead.id} 你也看看`, {}, undefined, "");
      yield* until(() => from(chat.defaultChannel(), lead.id)[0], "the answer from the one named");
      yield* orchestrator.say("默认频道里随便说", {}, undefined, "");
      yield* until(() => from(chat.defaultChannel(), defaultOrchestrator)[0], "the default one's answer");
      expect(asked("默认频道里随便说")[0]!.system).not.toContain("你是管家");
      expect(from(chat.defaultChannel(), lead.id)).toHaveLength(1);
      expect((yield* Effect.flip(chat.updateChannel(notes, { orchestrator: "lab" })))._tag).toBe("Refused");
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
      const kept = readFileSync(join(config.home, "agent", "orchestrator", "orchestrator.jsonl"), "utf8");
      expect(kept).toMatch(/"customType":"orchestratorInput"[^\n]*【现状】/);
      expect(kept).toMatch(/"customType":"orchestratorInput"[^\n]*"source":"owner","owner":true/);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("streams its words to a call", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { in: saidIn } = yield* Said;
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
        saidIn(chat.defaultChannel())
          .filter((m) => m.spoken || m.from === defaultOrchestrator)
          .map((m) => m.from + "：" + m.text);
      expect(yield* until(() => call().length === 2 && call(), "the call in the default channel")).toEqual(["owner：现在地里怎么样", "orchestrator：收到"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A line joining the run ends the brief before it with the words it got: it does not wait for the run's end.
  it.live("ends a brief when another line joins its run", () => {
    // The brief's first answer waits until the call's line has come, so the line joins a run under way.
    const release = gate();
    const f = farm((c) => {
      const line = lastLine(c);
      if (answeredWith(c) !== undefined) return answer("看过了");
      if (line.includes("要告诉主人")) return release.opened.then(() => answer([{ type: "text", text: "#41 交回来了" }, toolCall("session_list", {})]));
      return respond(c);
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const said = yield* Effect.promise(async () => {
        const brief = orchestrator.brief("【要告诉主人】\n- #41 交回来了");
        await whenTrue(() => f.requests.some((c) => lastLine(c).includes("要告诉主人")), "the brief's run asking");
        const joined = (async () => {
          for await (const _ of onPhone(orchestrator, "还有别的吗")) void _;
        })();
        // The call's line is taken in the next turn of the event loop; then the brief's answer may come.
        await new Promise((r) => setImmediate(r));
        release.open();
        const out = await within(brief, 4000, "the brief");
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
      // A caller already gone returns before the line is taken: nothing was started to wait for.
      expect(yield* Effect.promise(() => orchestrator.brief("【要告诉主人】\n- #41 交回来了", AbortSignal.abort()))).toBe("");
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("does not start an answer whose caller already left", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const words = orchestrator.answerer("api")(orchestratorModel)!("在吗", AbortSignal.abort());
      const said = yield* Effect.promise(async () => {
        let out = "";
        for await (const w of words) out += w;
        return out;
      });
      // Asked with a signal already off, it takes nothing: there is nothing to wait for.
      expect(said).toBe("");
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // The situation it is given is read from the farm; a read that fails ends the answer instead of leaving it open.
  it.live("ends an answer whose input could not be put together", () => {
    const f = (() => {
      const { llm, requests } = scriptedLLM([answer("收到")]);
      const below = world({
        config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } },
        runtimes: [pi],
        usage: () => {
          throw new Error("额度读不出来");
        },
      });
      return { requests, layer: Orchestrator.layer({ llm: () => llm }).pipe(Layer.provideMerge(below)) };
    })();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const got = yield* Effect.promise(async () => {
        const words = (async () => {
          for await (const _ of orchestrator.answerer("api")(orchestratorModel)!("在吗", new AbortController().signal)) void _;
          return "ended";
        })().catch((e: Error) => e.message);
        return within(words, 3000, "the answer");
      });
      expect(got).toContain("额度读不出来");
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("says once why it cannot start", () => {
    const below = world({ config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } } });
    return Effect.gen(function* () {
      const agents = yield* Agents;
      const orchestrator = yield* Orchestrator;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channels;
      const me = agents.agent(defaultOrchestrator)!;
      yield* agents.save({ ...me, model: "openai/gpt" });
      const pieces = (text: string) =>
        Effect.promise(async () => {
          const out: string[] = [];
          for await (const piece of onPhone(orchestrator, text)) out.push(piece);
          return out;
        });
      const first = yield* pieces("在吗");
      expect(first.length).toBe(1);
      expect(first[0]).toContain("只接 DeepSeek");
      const refusal = () => saidIn(chat.defaultChannel()).filter((m) => m.from === defaultOrchestrator);
      expect((yield* until(() => refusal()[0], "the refusal in the default channel")).text).toMatch(/^我这边起不来：/);
      expect((yield* pieces("还在吗")).length).toBe(1);
      // Taken one at a time: once a third is answered, the second's refusal was said or not.
      yield* pieces("（标记）");
      expect(refusal().length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(Orchestrator.layer().pipe(Layer.provideMerge(below))));
  });

  it.live("hears a send key once", () => {
    const f = farm();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      for (let i = 0; i < 2; i++) yield* orchestrator.say("地里怎么样", {}, undefined, "k1");
      for (let i = 0; i < 2; i++) yield* orchestrator.heard("电话里问一句", "", "k2");
      yield* until(() => words().length >= 2, "its words");
      yield* marked(f);
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
      const { all: saidAll } = yield* Said;
      const chat = yield* Channels;
      const lab = yield* enableLab;
      const hired = yield* issues.hire({ ...lab, enabled: true, effort: "" }, "写一份长汇报", "notes");
      const id = hired.session!.id;
      yield* until(() => saidAll().some((m) => m.from === id && m.kind === "report"), "its report");
      const spoken = yield* chat.speak(id, "@管家 " + "长".repeat(5000), { anyway: true });
      expect(spoken.kind).toBe("sent");
      const line = yield* until(() => f.requests.map(lastLine).find((l) => l.startsWith(intake.chat.head + "【群聊】")), "the orchestrator asked");
      expect(line).not.toContain("长".repeat(797));
      expect(line).toContain("@管家 " + "长".repeat(796) + "…（这条有 5004 字，全文用 channel_message_list 读 " + spoken.target + "）");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("completes an issue only when the owner asks, and says what it delivered", () => {
    let helper = "";
    let number = 0;
    const f = farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return answer("合并：" + result);
      const line = lastLine(c);
      // A helper's words name it by its name; the owner's, by the issue's number.
      if (line.includes("直接收")) return answer([toolCall("issue_status_update", { id: helper, status: "已完成" })]);
      if (line.includes("收下")) return answer([toolCall("issue_status_update", { id: "#" + number, status: "已完成" })]);
      return respond(c);
    });
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channels;
      const orchestrator = yield* Orchestrator;
      const lab = yield* enableLab;
      const hired = yield* issues.hire({ ...lab, enabled: true, effort: "" }, "写个 hello", "notes");
      helper = hired.session!.id;
      number = (yield* issues.get(hired.session!.issue!)).number;
      yield* until(() => sessions.roster().some((r) => r.session.id === helper && r.session.phase._tag === "done"), "the work handed back");
      yield* chat.speak(helper, "@管家 主人同意了，直接收", { anyway: true });
      const thread = (yield* chat.jobThread(helper))!;
      const refused = yield* until(() => saidIn(thread).find((m) => m.from === defaultOrchestrator && m.text.startsWith("合并：")), "the completion refused");
      expect(refused.text).toBe("合并：没挪：改工单、挪状态要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要这样做。");
      expect((yield* issues.get(hired.session!.issue!)).closedAt).toBeUndefined();
      yield* orchestrator.say("收下", {}, undefined, "");
      const merged = yield* until(async () => {
        const t = await runPromise(issues.get(hired.session!.issue!));
        return t.closedAt !== undefined && t;
      }, "merged");
      // The helper said its words and committed nothing: done, with nothing to merge, and said so.
      expect(merged.delivered).toBe("none");
      const general = (yield* Channels).defaultChannel();
      yield* until(
        () => saidIn(general).some((m) => m.from === defaultOrchestrator && m.text === `合并：#${number} 已完成，没有改动要合`),
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
      if (result !== undefined) return answer("工单：" + result);
      const line = lastLine(c);
      if (line.includes("记一下")) return answer([toolCall("issue_create", { title: "首页偶尔白屏", project: "demo", assignee: "lab" })]);
      if (line.includes("开工")) return answer([toolCall("issue_status_update", { id: "#" + number, status: "待办" })]);
      if (line.includes("在等我")) return answer([toolCall("issue_list", { wantsOwner: true })]);
      return respond(c);
    });
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
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
      yield* until(async () => (await runPromise(issues.get(issue.id))).status === "in_review", "handed back");
      yield* orchestrator.say("哪些在等我？", {}, undefined, "");
      const waiting = yield* until(() => words().find((w) => w.startsWith("工单：- #")), "listed");
      expect(waiting).toContain(`#${number}「首页偶尔白屏」等你验收`);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("lets a cron it sets unasked wait for the owner", () => {
    const daily = { name: "每日测试", text: "跑一遍测试", when: { kind: "daily", time: "09:00" } };
    let offset = 0;
    const f = farm(
      (c) => {
        const result = answeredWith(c);
        if (result !== undefined) return answer("定时任务：" + result);
        const line = lastLine(c);
        if (line.includes("每天九点") || line.includes("定时任务")) return answer([toolCall("cron_create", daily)]);
        return respond(c);
      },
      testConfig(),
      () => Date.now() + offset,
    );
    return Effect.gen(function* () {
      const crons = yield* Crons;
      const orchestrator = yield* Orchestrator;
      const words = yield* said;
      // Woken by a cron, not the owner: what it sets to come back daily waits.
      yield* crons.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, owner);
      // The farm's clock, not a wait, brings it due.
      offset = 100;
      yield* crons.tick;
      yield* until(() => words().some((w) => w.startsWith("定时任务：定好了，等主人同意才生效")), "the orchestrator told it waits");
      const mine = (enabled: boolean) => crons.list().filter((s) => s.name === "每日测试" && s.enabled === enabled);
      expect(mine(false)).toMatchObject([{ pending: true, by: "orchestrator" }]);
      yield* orchestrator.say("每天九点跑一遍测试", {}, undefined, "");
      const on = yield* until(() => mine(true).length === 1 && mine(true), "the owner's cron on");
      expect(on[0]).toMatchObject({ by: "orchestrator" });
      expect(on[0]!.pending ?? false).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // However its turn ends, the orchestrator's issue waits on the owner: a turn that did not fail is not an answer taken.
  it.live("leaves its issue for the owner to take as done", () => {
    let offset = 0;
    const f = farm(respond, testConfig(), () => Date.now() + offset);
    return Effect.gen(function* () {
      const crons = yield* Crons;
      const issues = yield* Issues;
      const s = yield* crons.add({ name: "看进度", text: "看看", when: { kind: "once", at: Date.now() + 50 } }, owner);
      // The farm's clock, not a wait, brings it due.
      offset = 100;
      yield* crons.tick;
      const core = yield* Core;
      const handed = yield* until(() => core.state().issues?.find((t) => t.cron === s.id && t.status === "in_review"), "handed back");
      const id = handed.id;
      expect(handed.closedAt).toBeUndefined();
      expect([handed.deliver, handed.lastRun?.outcome]).toEqual(["answer", "completed"]);
      expect(handed.attention).toMatchObject({ state: "reviewing", lead: "acknowledge" });
      // One table whoever did the work: asked again (todo), taken (done), or put away (canceled).
      expect(handed.moves).toEqual(["todo", "done", "canceled"]);
      const done = yield* issues.setStatus(id, "done", "", "", owner);
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
      yield* marked(f);
      expect(f.requests.some((c) => lastLine(c).includes("【巡查】"))).toBe(false);
      offset = 3 * 3_600_000;
      yield* notices.patrol;
      const line = yield* until(() => f.requests.map(lastLine).find((l) => patrolLine.test(l)), "the patrol's news");
      expect(line).toMatch(/^\[来源：巡查\]\n【巡查】#general 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没人看：「加个 CHANGELOG」/);
      offset = 3.5 * 3_600_000;
      yield* notices.patrol;
      yield* marked(f);
      // Each request carries the whole channel: count this work's patrol lines in the latest.
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
      const asked = yield* until(() => (sessions.events(defaultOrchestrator) ?? []).find((e) => e.type === "user/message"), "its log");
      const made = yield* orchestrator.markWrong(asked.seq, "应该先看一眼地里");
      const saved = JSON.parse(readFileSync(made.file, "utf8")) as Record<keyof EvalCase, unknown> & {
        input: { customType: string };
        did: { role: string }[];
        tools: string[];
      };
      // Written in session/host.ts, read as an EvalCase here: every field the reader expects is there.
      expect(Object.keys(saved).sort()).toEqual(["before", "createdAt", "did", "expect", "id", "input", "memory", "model", "tools", "want"]);
      expect(saved.want).toBe("应该先看一眼地里");
      expect(saved.input.customType).toBe("orchestratorInput");
      expect(saved.did.map((m) => m.role)).toContain("assistant");
      expect(saved.tools).toContain("issue_create");
      expect(saved.tools).toContain("remember");
      expect(yield* Effect.flip(orchestrator.markWrong(9_999, "x"))).toMatchObject({ _tag: "Missing" });
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
