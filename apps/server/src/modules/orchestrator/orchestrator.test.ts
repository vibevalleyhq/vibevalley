import { readFile } from "node:fs/promises";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { messageText } from "@vibevalley/agent/messages";
import { type Reply, type Request, scriptedLLM } from "@vibevalley/agent/testing";
import type { Message } from "@vibevalley/ai/messages";
import { type Answer, answer, toolCall } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { executionsOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { starter, testConfig, nextTurn, gate, untilGot as until, waitFor, whenTrue, within } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { makeOrchestrator, type Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { makeResponses } from "./response.ts";
import { deepseekModel, intake, orchestratorModel } from "./situation.ts";

/** A case markWrong wrote, as much of it as the test reads; every key is kept to be counted. */
const SavedCase = z.looseObject({
  input: z.object({ customType: z.string() }),
  did: z.array(z.object({ role: z.string() })),
  tools: z.array(z.string()),
  want: z.string(),
});

/** Words said to the orchestrator on the phone, as the voice line asks them. */
const onPhone = (orchestrator: Orchestrator, text: string) => orchestrator.answerer("phone")(orchestratorModel)!(text);

const userText = (m: Message) => (m.role === "user" ? messageText(m) : undefined);
const lastInput = (c: Request) => c.messages.map(userText).findLast((t) => t !== undefined) ?? "";
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

const asked = /加个 (README|CHANGELOG)$/mu;

const respond = (c: Request): Answer => {
  const result = answeredWith(c);
  if (result !== undefined) return answer("好，" + [...result].slice(0, 2).join("") + "了");
  const want = lastLine(c).startsWith("[来源：用户]") ? asked.exec(sinceAnswer(c))?.[0] : undefined;
  if (want)
    return answer([
      toolCall(
        "issue_create",
        want.includes("CHANGELOG") ? { title: want, repo: "notes", agent: "lab", start: true } : { title: want, repo: "demo", start: true },
      ),
    ]);
  if (lastLine(c).includes("定时任务")) return answer("到点了，看了一眼");
  return answer("收到");
};

const pi = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做完了") });

type Farm = Awaited<ReturnType<typeof world>>;

/** The farm with an orchestrator on it, closed orchestrator first. */
const orchestrated = async (below: Farm, options: OrchestratorOptions = {}) => {
  const orchestrator = await makeOrchestrator(below, options);
  return {
    farm: below,
    orchestrator,
    [Symbol.asyncDispose]: async () => {
      try {
        await orchestrator.close();
      } finally {
        await below[Symbol.asyncDispose]();
      }
    },
  };
};

/** The patrol runs by hand: heartbeatMinutes 0 leaves nothing to the timer. */
const farm = async (f: Reply = respond, config: ServerConfig = testConfig()) => {
  const { llm, requests } = scriptedLLM(Array.from({ length: 100 }, () => f));
  const below = await world({
    config: { ...config, patrol: { heartbeatMinutes: 0 } },
    runtimes: [pi],
    repos: ["demo", "notes"],
  });
  below.deepseek.use(llm);
  return Object.assign(await orchestrated(below), { requests });
};

/** The orchestrator's conversation as kept in durable.db, an entry a line. */
const transcript = async (farm: Farm, orchestrator: string) => {
  const kept = await farm.runtime.durable.existing(orchestrator);
  if (!kept) return "";
  const { items } = await kept.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
  return items.map((e) => JSON.stringify(e)).join("\n");
};

/** Everything handed to the orchestrator before this is taken once this is: it takes one input at a time. */
const marked = async (f: { readonly farm: Farm; readonly requests: readonly Request[] }) => {
  const before = f.requests.length;
  await f.farm.channel.say("（标记）", {}, undefined, "");
  await until(() => f.requests.slice(before).some((c) => lastLine(c).includes("（标记）")), "the marker taken");
};

const enableLab = async (farm: Farm) => {
  const lab = starter("lab");
  await farm.agent.save({ ...lab, enabled: true, effort: "" });
  return lab;
};

const said = (farm: Farm) => () =>
  farm.said
    .in(farm.channel.defaultChannel())
    .filter((m) => m.from === defaultOrchestrator && m.kind === "chat")
    .map((m) => m.text);

/** Date.now moved on by hand, the farm's clock with it; timers stay real. */
const fakeDate = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  return {
    adjust: (ms: number) => vi.setSystemTime(Date.now() + ms),
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
};

describe("the orchestrator", () => {
  it("regression: an oversized manager note cannot create an issue", async () => {
    await using f = await farm((request) =>
      answeredWith(request) !== undefined
        ? answer("stopped")
        : answer([toolCall("issue_create", { title: "oversized note", description: "word ".repeat(31), repo: "demo" })]),
    );
    await f.farm.channel.say("record the work", {}, undefined, "");
    await until(() => f.requests.some((request) => answeredWith(request)?.includes("30") === true), "the rejected note");
    const found = await f.farm.issue.list();
    expect(found).toHaveLength(0);
  });
  it("takes DeepSeek's models only", () => {
    expect(deepseekModel("", "deepseek-flash")).toBe("deepseek-flash");
    expect(deepseekModel("deepseek/deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(deepseekModel("deepseek-v4-pro", "x")).toBe("deepseek-v4-pro");
    expect(() => deepseekModel("anthropic/claude", "x")).toThrow(/只接 DeepSeek/u);
  });

  it("writes an issue down and starts it, and hears the user's voice in the default channel", async () => {
    await using f = await farm();
    const { session: sessions, issue: issues, channel: chat } = f.farm;
    const saidIn = f.farm.said.in;
    await enableLab(f.farm);
    const words = said(f.farm);
    await chat.say("帮我在 demo 里加个 README", {}, undefined, "");
    const reached = await until(() => words().length >= 1 && words(), "its words");
    expect(reached).toEqual(["好，记下了"]);
    const origin = saidIn(chat.defaultChannel()).find((message) => message.from === "user" && message.text.includes("加个 README"))!;
    const created = (await issues.list()).find((item) => item.title.includes("README"))!;
    expect(created.mandate).toMatchObject({ originTriggerId: origin.id, strength: "explicit", autoSubmitPr: false });
    const first = f.requests[0]!;
    expect(lastInput(first)).toMatch(/^【现在】\d{4}\/\d+\/\d+ \d\d:\d\d\n\n【现状】[\s\S]*可以派的帮工：\n- /u);
    expect(first.system).not.toContain("【现状】");
    expect(lastLine(first)).toBe("[来源：用户]\n用户说：帮我在 demo 里加个 README");
    const trail = await waitFor(
      async () => ((await sessions.events(defaultOrchestrator)) ?? []).filter((e) => e.type !== "llm/usage"),
      (events) => events.length >= 6 && events.at(-1)!.type === "run/end",
      "its log",
    );
    const [ask, tool, result, answer] = trail.slice(-5, -1);
    expect(result).toMatchObject({ type: "tool/result", call: tool!.seq, ok: true });
    expect(ask!.type).toBe("user/message");
    expect(ask!.text).toMatch(/^\[来源：用户\][\s\S]*加个 README/u);
    expect(tool).toMatchObject({ tool: "issue_create", text: "记一张工单：demo" });
    expect(tool!.input).toContain(`"repo":"demo"`);
    expect(answer!.text).toBe("好，记下了");
    expect(sessions.hired().map((session) => session.repo)).toEqual(["demo"]);
    const worker = sessions.hired()[0]!;
    expect((await f.farm.tool.readResource(worker.id, { uri: `vv://trigger/${origin.id}` })).text).toContain(origin.text);
    await until(() => sessions.hired()[0]?.lastRun, "its report");

    const before = f.requests.length;
    await chat.user({ source: "voice", voiceMode: "dictated", text: "随便说一句", envelope: "" });
    await until(() => f.requests.length > before, "the orchestrator asked");
    expect((await until(() => words().length >= 2 && words(), "its words")).at(-1)).toBe("收到");
    const answered = f.requests.length;
    await marked(f);
    expect(saidIn(chat.defaultChannel()).some((m) => m.from === "user" && m.text === "随便说一句" && m.spoken)).toBe(true);
    expect(f.requests.slice(before).filter((c) => lastLine(c).includes("随便说一句")).length).toBe(1);
    expect(lastLine(f.requests[answered - 1]!)).toContain("语音那边已经回答了");
  });

  it("is shown the user's note repos, and the notes the user's words call up", async () => {
    await using f = await farm();
    const { channel: chat, pkm } = f.farm;
    await pkm.save({ title: "Beehives", tier: "project", markdown: "- TODO check the queens every week\n" });
    await chat.say("蜂箱的 queens 怎么样了", {}, undefined, "");
    await until(() => f.requests.length > 0, "the orchestrator asked");
    const input = lastInput(f.requests.at(-1)!);
    expect(input).toMatch(/用户笔记里在做的项目[\s\S]*- 《Beehives》（1 件没做完）/u);
    expect(input).toMatch(/【笔记里可能相关的】[\s\S]*《Beehives》TODO check the queens every week/u);
    expect(f.requests.filter((r) => lastInput(r).includes("【笔记里可能相关的】")).length).toBe(1);
  });

  it("answers the user in their direct channel", async () => {
    await using f = await farm();
    const saidIn = f.farm.said.in;
    const chat = f.farm.channel;
    const direct = f.farm.core.state().chat!.channels.find((c) => c.type === "direct" && c.peer === defaultOrchestrator)!;
    await chat.say("单独问你一句：地里怎么样", {}, direct.id, "");
    const answered = () => saidIn(direct.id).filter((m) => m.from === defaultOrchestrator);
    expect((await until(() => answered().length >= 1 && answered(), "its answer there")).map((m) => m.text)).toEqual(["收到"]);
    expect(saidIn(chat.defaultChannel()).some((m) => m.from === defaultOrchestrator)).toBe(false);
    const asked = f.requests.at(-1)!;
    expect(lastLine(asked)).toBe("[来源：用户]\n用户说：单独问你一句：地里怎么样");
    expect(lastInput(asked)).toContain("你正在回话的地方：和用户的私聊 @user");
  });

  it("several orchestrators: each answers in its own direct channel, the channels it looks after and where it is named", async () => {
    const config = testConfig();
    await using f = await farm(respond, config);
    const { agent: agents, channel: chat, core } = f.farm;
    const saidIn = f.farm.said.in;
    const lead = await agents.create({ ...agents.agent(defaultOrchestrator)!, id: "", name: "阿青", persona: "你专管 notes。" });
    const from = (channel: string, who: string) => saidIn(channel).filter((m) => m.from === who && m.kind === "chat");
    const asked = (text: string) => f.requests.filter((c) => lastLine(c).includes(text));

    const direct = await chat.direct(lead.name);
    expect(direct).not.toBe(chat.defaultChannel());
    await chat.say("私下问你", {}, direct, "");
    expect((await until(() => from(direct, lead.id)[0], "its answer in its direct channel")).name).toBe("阿青");
    expect(asked("私下问你")[0]!.system).toContain("你是助手「阿青」");
    const log = await transcript(f.farm, lead.id);
    expect(log).toContain("私下问你");

    const notes = (await chat.openChannel("notes-room", "", "")).id;
    // A new channel has the default orchestrator in it; the user puts 阿青 there instead.
    const membersOfNotes = () => (core.state().chat?.channels ?? []).find((c) => c.id === notes)?.members;
    expect(membersOfNotes()).toEqual([defaultOrchestrator]);
    await chat.updateChannel(notes, { members: [lead.id] });
    expect(membersOfNotes()).toEqual([lead.id]);
    expect(chat.orchestratorIn(notes)).toBe(lead.id);
    await chat.say("这边怎么样", {}, notes, "");
    await until(() => from(notes, lead.id)[0], "the answer from the one in the channel");
    await chat.say(`@${lead.id} 你也看看`, {}, undefined, "");
    await until(() => from(chat.defaultChannel(), lead.id)[0], "the answer from the one named");
    await chat.say("默认频道里随便说", {}, undefined, "");
    await until(() => from(chat.defaultChannel(), defaultOrchestrator)[0], "the default one's answer");
    expect(asked("默认频道里随便说")[0]!.system).not.toContain("你是助手");
    // Its own skills are listed for it to load: /imagegen is one.
    expect(asked("默认频道里随便说")[0]!.system).toContain("imagegen");
    expect(from(chat.defaultChannel(), lead.id)).toHaveLength(1);
    const refused = await chat.updateChannel(notes, { members: ["lab"] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ bizCode: BizCode.ChannelRefused });
  });

  it("keeps its inputs with where they came from", async () => {
    const config = testConfig();
    await using f = await farm(respond, config);
    const chat = f.farm.channel;
    const words = said(f.farm);
    expect(f.farm.core.state().call).not.toBe("live");
    await chat.say("地里怎么样", {}, undefined, "");
    // The user speaking, from any door, opens the farm.
    expect(f.farm.core.state().call).toBe("live");
    await until(() => words().length >= 1, "its words");
    const kept = await transcript(f.farm, "orchestrator");
    expect(kept).toMatch(/"kind":"orchestratorInput"[^\n]*【现状】/u);
    expect(kept).toMatch(/"kind":"orchestratorInput"[^\n]*"source":"user","user":true/u);
  });

  it("streams its words to a call", async () => {
    await using f = await farm();
    const response = f.orchestrator;
    const saidIn = f.farm.said.in;
    const chat = f.farm.channel;
    let got = "";
    for await (const piece of onPhone(response, "现在地里怎么样")) got += piece;
    expect(got).toBe("收到\n");
    const rows = await f.farm.db.sql.query(`select d.source, m.meta from mailbox_delivery d
          join channel_message m on m.id = d.message_id where m.body = '现在地里怎么样'`);
    expect(rows).toEqual([
      {
        source: "voice",
        meta: expect.stringMatching(/"ingressSource":"voice".*"responsePort":"[^"]+".*"voiceMode":"conversation"/u),
      },
    ]);
    expect(lastLine(f.requests.at(-1)!)).toMatch(/用户在电话里说的[\s\S]*用户说：现在地里怎么样/u);
    expect(f.requests.length).toBe(1);
    const call = () =>
      saidIn(chat.defaultChannel())
        .filter((m) => m.spoken || m.from === defaultOrchestrator)
        .map((m) => m.from + "：" + m.text);
    const reached = await until(() => call().length === 2 && call(), "the call in the default channel");
    expect(reached).toEqual(["user：现在地里怎么样", "orchestrator：收到"]);
  });

  // A line joining the run ends the brief before it with the words it got: it does not wait for the run's end.
  it("ends a brief when another line joins its run", async () => {
    // The brief's first answer waits until the call's line has come, so the line joins a run under way.
    const release = gate();
    await using f = await farm((c) => {
      const line = lastLine(c);
      if (answeredWith(c) !== undefined) return answer("看过了");
      if (line.includes("要告诉用户")) return release.opened.then(() => answer([{ type: "text", text: "#41 交回来了" }, toolCall("session_list", {})]));
      return respond(c);
    });
    const response = f.orchestrator;
    const brief = response.brief("【要告诉用户】\n- #41 交回来了");
    await whenTrue(() => f.requests.some((c) => lastLine(c).includes("要告诉用户")), "the brief's run asking");
    const joined = (async () => {
      for await (const _ of onPhone(response, "还有别的吗")) void _;
    })();
    // The call's line is taken in the next turn of the event loop; then the brief's answer may come.
    await nextTurn();
    release.open();
    await joined;
    const briefSaid = await within(brief, 4000, "waited for the brief");
    expect(briefSaid).toContain("#41 交回来了");
    const rows = await f.farm.db.sql.query(`select id from channel_message where body like '%【要告诉用户】%'`);
    expect(rows).toHaveLength(0);
    const rows2 = await f.farm.db.sql.query(`select id from mailbox_trigger where payload_json::jsonb ->> 'text' = '【要告诉用户】
- #41 交回来了'`);
    expect(rows2).toHaveLength(1);
  });

  it("does not start a brief whose caller already left", async () => {
    await using f = await farm();
    const response = f.orchestrator;
    // A brief whose caller left before it runs takes no line: nothing was started to wait for.
    const left = new AbortController();
    left.abort();
    await response.brief("【要告诉用户】\n- #41 交回来了", left.signal).catch((e: unknown) => e);
    expect(f.requests).toHaveLength(0);
  });

  it("does not start an answer whose caller already left", async () => {
    await using f = await farm();
    const response = f.orchestrator;
    // A caller that left before reading: its answer was never read, so it never started.
    void response.answerer("api")(orchestratorModel)!("在吗");
    await nextTurn();
    expect(f.requests).toHaveLength(0);
  });

  it("a new interactive response ends the previous port that is still open", async () => {
    await using f = await farm();
    const responses = makeResponses(f.farm.mailbox, f.farm.channel, f.farm.clock);
    const collect = async (words: AsyncIterable<string>) => {
      const out: string[] = [];
      for await (const w of words) out.push(w);
      return out;
    };
    const first = responses.open(true);
    const second = responses.open(true);
    const collectOutcome = await collect(first.caller.words());
    // The newer interactive response ends the older one's words.
    expect(collectOutcome).toEqual([]);
    // Taking a port hands it on and forgets it; dropping the last one leaves nothing to close.
    expect(responses.take(second.id)).toBe(second.caller);
    expect(responses.take(second.id)).toBeUndefined();
    responses.drop(first.id);
    // Closing the registry ends whatever is still open.
    const third = responses.open(false);
    const waiting = collect(third.caller.words());
    responses.closeAll();
    const waiting2 = await waiting;
    expect(waiting2).toEqual([]);
  });

  it("processes a durable response envelope after its process-local port is gone", async () => {
    await using f = await farm();
    const words = said(f.farm);
    await f.farm.channel.user({ source: "voice", voiceMode: "api", responsePort: "gone-after-restart", text: "重启后继续", envelope: "gone-1" });
    const reached = await until(() => words().at(-1), "the answer without its response port");
    expect(reached).toBe("收到");
    expect(lastLine(f.requests.at(-1)!)).toContain("重启后继续");
  });

  // The situation it is given is read from the farm; a read that fails ends the answer instead of leaving it open.
  it("ends an answer whose input could not be put together", async () => {
    const { llm, requests } = scriptedLLM([answer("收到")]);
    const below = await world({
      config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } },
      runtimes: [pi],
      usage: () => {
        throw new Error("额度读不出来");
      },
    });
    below.deepseek.use(llm);
    await using f = await orchestrated(below);
    const response = f.orchestrator;
    const words = (async () => {
      for await (const _ of response.answerer("api")(orchestratorModel)!("在吗")) void _;
      return "ended";
    })().catch((e: Error) => e.message);
    const got = await within(words, 3000, "the answer");
    expect(got).toContain("额度读不出来");
    expect(requests).toHaveLength(0);
  });

  it("says once why it cannot start", async () => {
    const below = await world({ config: { ...testConfig(), patrol: { heartbeatMinutes: 0 } } });
    await using f = await orchestrated(below);
    const agents = f.farm.agent;
    const response = f.orchestrator;
    const saidIn = f.farm.said.in;
    const chat = f.farm.channel;
    const me = agents.agent(defaultOrchestrator)!;
    await agents.save({ ...me, model: "openai/gpt" });
    const pieces = async (text: string) => {
      const out: string[] = [];
      for await (const piece of onPhone(response, text)) out.push(piece);
      return out;
    };
    const first = await pieces("在吗");
    expect(first.length).toBe(1);
    expect(first[0]).toContain("只接 DeepSeek");
    const refusal = () => saidIn(chat.defaultChannel()).filter((m) => m.from === defaultOrchestrator);
    expect((await until(() => refusal()[0], "the refusal in the default channel")).text).toMatch(/^我这边起不来：/u);
    expect((await pieces("还在吗")).length).toBe(1);
    // Taken one at a time: once a third is answered, the second's refusal was said or not.
    await pieces("（标记）");
    expect(refusal().length).toBe(1);
  });

  it("hears a send key once", async () => {
    await using f = await farm();
    const chat = f.farm.channel;
    for (let i = 0; i < 2; i++) await chat.say("地里怎么样", {}, undefined, "k1");
    for (let i = 0; i < 2; i++) await chat.user({ source: "voice", voiceMode: "dictated", text: "电话里问一句", envelope: "k2" });
    await until(
      () =>
        f.requests.some((request) =>
          ["地里怎么样", "电话里问一句"].every((line) => request.messages.some((message) => userText(message)?.includes(line) === true)),
        ),
      "both unique inputs reaching the model",
    );
    await marked(f);
    const heard = { 地里怎么样: 0, 电话里问一句: 0 };
    for (const m of f.requests.at(-1)!.messages) {
      const text = userText(m);
      if (text === undefined) continue;
      for (const k of Object.keys(heard) as (keyof typeof heard)[]) if (text.includes(k)) heard[k]++;
    }
    expect(heard).toEqual({ 地里怎么样: 1, 电话里问一句: 1 });
    const saidFailure = await chat.say("早", {}, undefined, "k".repeat(65)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(saidFailure).toBeDefined();
  });

  it("is told the sowing form's pick", async () => {
    await using f = await farm();
    const chat = f.farm.channel;
    const lab = await enableLab(f.farm);
    const words = said(f.farm);
    await chat.say("修一个 bug：登录闪退", { agent: lab.id, repo: " notes " }, undefined, "");
    await until(() => words().length >= 1, "its words");
    expect(lastLine(f.requests[0]!)).toMatch(
      new RegExp(`（用户在对话框里选定了帮工：${lab.name}）\n（用户选定了仓库：notes，派活就派在这个仓库里）\n用户说：修一个 bug：登录闪退$`, "u"),
    );
  });

  it("hears a long report cut", async () => {
    await using f = await farm();
    const issues = f.farm.issue;
    const saidAll = f.farm.said.all;
    const chat = f.farm.channel;
    const lab = await enableLab(f.farm);
    const hired = await issues.hire({ ...lab, enabled: true, effort: "" }, "写一份长汇报", "notes");
    const id = hired.session.id;
    await until(() => saidAll().some((m) => m.from === id && m.kind === "report"), "its report");
    const spoken = await chat.post({ _tag: "Agent", from: id, text: "@助手 " + "长".repeat(5000), anyway: true });
    expect(spoken.kind).toBe("sent");
    const line = await until(() => f.requests.map(lastLine).find((l) => l.startsWith(intake.chat.head + "【群聊】")), "the orchestrator asked");
    expect(line).not.toContain("长".repeat(597));
    expect(line).toContain("@助手 " + "长".repeat(596));
    expect(line).toContain(`vv://trigger/${spoken.message!.id}`);
  });

  it("completes an issue only when the user asks, and says what it delivered", async () => {
    let helper = "";
    let number = 0;
    await using f = await farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return answer("合并：" + result);
      const line = lastLine(c);
      // A helper's words name it by its name; the user's, by the issue's number.
      if (line.includes("直接收")) return answer([toolCall("issue_status_update", { id: helper, status: "已完成" })]);
      if (line.includes("收下")) return answer([toolCall("issue_status_update", { id: "#" + number, status: "已完成" })]);
      return respond(c);
    });
    const { issue: issues, session: sessions, channel: chat } = f.farm;
    const saidIn = f.farm.said.in;
    const lab = await enableLab(f.farm);
    const hired = await issues.hire({ ...lab, enabled: true, effort: "" }, "写个 hello", "notes");
    helper = hired.session.id;
    const issueId = hired.session.issue!;
    number = (await issues.get(issueId)).number;
    await until(() => sessions.hired().some((session) => session.id === helper && session.phase._tag === "done"), "the work handed back");
    await chat.post({ _tag: "Agent", from: helper, text: "@助手 用户同意了，直接收", anyway: true });
    const thread = (await chat.threadOfSession(helper))!;
    const refused = await until(() => saidIn(thread).find((m) => m.from === defaultOrchestrator && m.text.startsWith("合并：")), "the completion refused");
    expect(refused.text).toBe("合并：没挪：改工单、挪状态要用户说一声。这一轮不是用户叫你的：在频道里问用户要不要这样做。");
    expect((await issues.get(issueId)).closedAt).toBeUndefined();
    await chat.say("收下", {}, undefined, "");
    const merged = await waitFor(
      () => issues.get(issueId),
      (t) => t.closedAt !== undefined,
      "merged",
    );
    // The helper said its words and committed nothing: done, with nothing to merge, and said so.
    expect(merged.delivered).toBe("none");
    const general = chat.defaultChannel();
    await until(
      () => saidIn(general).some((m) => m.from === defaultOrchestrator && m.text === `合并：#${number} 已完成，没有改动要合`),
      "what it delivered said",
    );
  });

  // The user's words name issues by number: noted down without anyone sent, started on the user's say, found again
  // among those waiting on the user.
  it("works in issues", async () => {
    let number = 0;
    await using f = await farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return answer("工单：" + result);
      const line = lastLine(c);
      if (line.includes("记一下")) return answer([toolCall("issue_create", { title: "首页偶尔白屏", repo: "demo", agent: "lab" })]);
      if (line.includes("开工")) return answer([toolCall("issue_status_update", { id: "#" + number, status: "待办" })]);
      if (line.includes("在等我")) return answer([toolCall("issue_list", { wantsUser: true })]);
      return respond(c);
    });
    const { issue: issues, channel: chat } = f.farm;
    const words = said(f.farm);
    await enableLab(f.farm);
    await chat.say("记一下：首页偶尔白屏", {}, undefined, "");
    const noted = await until(() => words().find((w) => w.startsWith("工单：记下了")), "noted");
    const issue = (await issues.list()).find((t) => t.title === "首页偶尔白屏")!;
    number = issue.number;
    expect(noted).toBe(`工单：记下了：#${number}「首页偶尔白屏」，在备选里，没开工`);
    expect([issue.status, executionsOf(issue)]).toEqual(["backlog", []]);
    await chat.say(`#${number} 开工`, {}, undefined, "");
    await until(() => words().some((w) => w.startsWith("工单：挪好了")), "started");
    await waitFor(
      () => issues.get(issue.id),
      (i) => i.status === "in_review",
      "handed back",
    );
    await chat.say("哪些在等我？", {}, undefined, "");
    const waiting = await until(() => words().find((w) => w.startsWith("工单：- #")), "listed");
    expect(waiting).toContain(`#${number}「首页偶尔白屏」等你验收`);
  });

  it("lets a cron it sets unasked wait for the user", async () => {
    const daily = { name: "每日测试", text: "跑一遍测试", when: { kind: "daily", time: "09:00" } };
    using clock = fakeDate();
    await using f = await farm((c) => {
      const result = answeredWith(c);
      if (result !== undefined) return answer("定时任务：" + result);
      const line = lastLine(c);
      if (line.includes("每天九点") || line.includes("定时任务")) return answer([toolCall("cron_create", daily)]);
      return respond(c);
    }, testConfig());
    const { cron: crons, channel: chat } = f.farm;
    const words = said(f.farm);
    // Woken by a cron, not the user: what it sets to come back daily waits.
    await crons.add({ name: "看进度", text: "看看", when: { kind: "once", at: f.farm.clock.now() + 50 } }, user);
    // The farm's clock, not a wait, brings it due.
    clock.adjust(100);
    await crons.tick();
    await until(() => words().some((w) => w.startsWith("定时任务：定好了，等用户同意才生效")), "the orchestrator told it waits");
    const mine = (enabled: boolean) => crons.list().filter((s) => s.name === "每日测试" && s.enabled === enabled);
    expect(mine(false)).toMatchObject([{ pending: true, by: "agent" }]);
    await chat.say("每天九点跑一遍测试", {}, undefined, "");
    const on = await until(() => mine(true).length === 1 && mine(true), "the user's cron on");
    expect(on[0]).toMatchObject({ by: "agent" });
    expect(on[0]!.pending).toBe(false);
  });

  // However its turn ends, the orchestrator's issue waits on the user: a turn that did not fail is not an answer taken.
  it("leaves its issue for the user to take as done", async () => {
    using clock = fakeDate();
    await using f = await farm(respond, testConfig());
    const { cron: crons, issue: issues, core } = f.farm;
    const s = await crons.add({ name: "看进度", text: "看看", when: { kind: "once", at: f.farm.clock.now() + 50 } }, user);
    // The farm's clock, not a wait, brings it due.
    clock.adjust(100);
    await crons.tick();
    const handed = await until(() => core.state().issues.find((t) => t.cron === s.id && t.status === "in_review"), "handed back");
    const id = handed.id;
    expect(handed.closedAt).toBeUndefined();
    expect([handed.deliver, handed.lastRun?.outcome]).toEqual(["answer", "completed"]);
    expect(handed.stage).toMatchObject({ state: "reviewing", lead: "acknowledge" });
    // One table whoever did the work: asked again (todo), taken (done), or put away (canceled).
    expect(handed.moves).toEqual(["todo", "done", "canceled"]);
    const done = await issues.setStatus(id, "done", "", "", user);
    expect([done.status, done.delivered]).toEqual(["done", "none"]);
  });

  it("hears the patrol once with the next user input", async () => {
    using clock = fakeDate();
    await using f = await farm(respond, testConfig());
    const { channel: chat, inbox, session: sessions } = f.farm;
    await enableLab(f.farm);
    await chat.say("帮我在 notes 里加个 CHANGELOG", {}, undefined, "");
    await until(
      () => sessions.hired().some((session) => session.brief.split("\n")[0] === "加个 CHANGELOG" && session.phase._tag === "done"),
      "the work handed back",
    );
    await inbox.patrol();
    await marked(f);
    expect(f.requests.some((c) => lastLine(c).includes("【巡查】"))).toBe(false);
    clock.adjust(3 * 3_600_000);
    await inbox.patrol();
    expect(f.farm.mailbox.deliveriesOf(defaultOrchestrator).some((row) => row.source === "patrol" && row.urgency === "digest")).toBe(true);
    await marked(f);
    const line = await until(() => f.requests.map(lastInput).find((input) => input.includes("【巡查】")), "the patrol digest");
    expect(line).toContain("「加个 CHANGELOG」");
    clock.adjust(0.5 * 3_600_000);
    await inbox.patrol();
    await marked(f);
    // Each request carries the whole channel: count this work's patrol lines in the latest.
    const latest = f.requests.at(-1)!;
    expect(latest.messages.filter((m) => (userText(m) ?? "").includes("【巡查】")).length).toBe(1);
  });

  it("saves a turn the user marks wrong as a case", async () => {
    const config = testConfig();
    await using f = await farm(respond, config);
    const { channel: chat, session: sessions } = f.farm;
    const words = said(f.farm);
    await chat.say("地里怎么样", {}, undefined, "");
    await until(() => words().length >= 1, "its words");
    const asked = (await waitFor(
      async () => ((await sessions.events(defaultOrchestrator)) ?? []).find((e) => e.type === "user/message"),
      (e) => e !== undefined,
      "its log",
    ))!;
    const made = await f.orchestrator.markWrong(asked.seq, "应该先看一眼地里");
    const text = await readFile(made.file, "utf8");
    const saved = SavedCase.parse(JSON.parse(text));
    // Written in session/host.ts, read as an EvalCase here: every field the reader expects is there.
    expect(Object.keys(saved).toSorted()).toEqual(["before", "createdAt", "did", "expect", "id", "input", "memory", "model", "tools", "want"]);
    expect(saved.want).toBe("应该先看一眼地里");
    expect(saved.input.customType).toBe("orchestratorInput");
    expect(saved.did.map((m) => m.role)).toContain("assistant");
    expect(saved.tools).toContain("issue_create");
    expect(saved.tools).toContain("remember");
    const markWrongFailure = await f.orchestrator.markWrong(9999, "x").catch((e: unknown) => e);
    expect(markWrongFailure).toBeInstanceOf(ApiError);
    expect(markWrongFailure).toMatchObject({ bizCode: BizCode.NotFound });
  });
});
