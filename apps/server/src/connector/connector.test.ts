import { describe, expect, it } from "@effect/vitest";
import { rmSync } from "node:fs";
import { type ConnectorID, type ConnectorState, type ConnectorStatus, orchestratorAgent } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Channels } from "../channel/chat.ts";
import { layer as orchestrator } from "../orchestrator/orchestrator.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { Connectors, layer } from "./connector.ts";
import type { FeishuApi, Message as FeishuMessage } from "./feishu.ts";
import { type QQApi, type Message as QQMessage, SendError } from "./qq.ts";
import { type Message as WeixinMessage, type WeixinApi, WeixinError, baseUrl } from "./weixin.ts";
import { untilGot as until } from "../testing/until.ts";
import * as accountQ from "../../db/generated/connector_account.sql.ts";
import * as inboundQ from "../../db/generated/connector_inbound.sql.ts";

const owner = "o9cq80wkM5NnOwnerOfThisFarm@im.wechat";

interface Sent {
  readonly app: ConnectorID;
  readonly to: string;
  readonly text: string;
  readonly reply: string;
}

/** Messages waiting to be taken, one at a time. */
class Inbox<A> {
  private readonly items: A[] = [];
  private wake: (() => void) | undefined;
  push(a: A) {
    this.items.push(a);
    this.wake?.();
  }
  async take(signal: AbortSignal, ms = Infinity): Promise<A | undefined> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) return next;
      if (signal.aborted) return undefined;
      const woke = await new Promise<boolean>((resolve) => {
        const t = Number.isFinite(ms) ? setTimeout(() => resolve(false), ms) : undefined;
        this.wake = () => (clearTimeout(t), resolve(true));
        signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
      });
      this.wake = undefined;
      if (!woke) return undefined;
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
  });

/** The three apps, played: what they are sent is kept; restricted, they refuse a reply as an expired window does. */
class Script {
  readonly sent: Sent[] = [];
  restricted = false;
  readonly weixinIn = new Inbox<WeixinMessage>();
  readonly feishuIn = new Inbox<FeishuMessage>();
  readonly qqIn = new Inbox<QQMessage>();
  private record(s: Sent) {
    this.sent.push(s);
    return this.sent.length;
  }
  by = (app: ConnectorID) => this.sent.filter((s) => s.app === app);

  readonly weixin: WeixinApi = {
    login: async (signal, progress) => {
      progress("waiting", "https://liteapp.weixin.qq.com/q/q1");
      if (!(await sleep(20, signal))) throw new Error("canceled");
      progress("scanned", "https://liteapp.weixin.qq.com/q/q1");
      if (!(await sleep(20, signal))) throw new Error("canceled");
      return { account: { baseUrl, token: "tok" }, botId: "bot1@im.bot", owner };
    },
    getUpdates: async (signal, _account, buf) => {
      const m = await this.weixinIn.take(signal, 100);
      return m ? { ret: 0, msgs: [m], get_updates_buf: buf + "+" } : { ret: 0, get_updates_buf: buf };
    },
    sendText: async (_signal, _account, to, text, contextToken) => {
      if (this.restricted) throw new WeixinError("sendmessage: -2", -2);
      return "wx" + this.record({ app: "weixin", to, text, reply: contextToken });
    },
  };

  readonly feishu: FeishuApi = {
    login: async (signal, progress) => {
      progress("https://open.feishu.cn/page/cli?user_code=AB");
      if (!(await sleep(40, signal))) throw new Error("canceled");
      return { app: { appId: "cli_1", appSecret: "s", domain: "feishu" }, owner: "" };
    },
    listen: async (signal, _app, got) => {
      for (;;) {
        const m = await this.feishuIn.take(signal);
        if (!m) return;
        await got(m);
      }
    },
    sendText: async (_signal, _app, openId, text) => "om_" + this.record({ app: "feishu", to: openId, text, reply: "" }),
  };

  readonly qq: QQApi = {
    check: async (_signal, app) => {
      if (app.secret !== "right") throw new Error("QQ 鉴权：AppID 或 AppSecret 不对");
    },
    listen: async (signal, _app, got) => {
      for (;;) {
        const m = await this.qqIn.take(signal);
        if (!m) return;
        await got(m);
      }
    },
    sendText: async (_signal, _app, openId, text, msgId) => {
      if (this.restricted) throw new SendError("QQ 发消息：被动回复超时", 400);
      return "qq" + this.record({ app: "qq", to: openId, text, reply: msgId });
    },
  };
}

let ids = 100;
const wx = (who: string, text: string, context = ""): WeixinMessage => {
  const id = ++ids;
  return { message_id: String(id), from_user_id: who, message_type: 1, context_token: context || `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }] };
};
const qqMsg = (from: string, content: string): QQMessage => ({ id: `qm${++ids}`, from, content, attachments: 0 });
const feishuMsg = (from: string, text: string, chatType = "p2p"): FeishuMessage => ({
  messageId: `om${++ids}`,
  from,
  chatType,
  messageType: "text",
  content: JSON.stringify({ text }),
  parentId: "",
});

let says = 0;
/** The orchestrator, played: what it hears goes into the channel, and it answers 收到 at once. */
const farm = (script: Script, config = testConfig(), retry: { retryFirstMs?: number; retryMostMs?: number } = {}) =>
  layer({
    weixin: script.weixin,
    feishu: script.feishu,
    qq: script.qq,
    ...retry,
    say: (text, conversation, chat) =>
      Effect.flatMap(chat.say(text, conversation, ""), ({ message }) =>
        chat.orchestratorSays(message.conversation, `k${++says}`, "收到：**" + text + "**", true, ""),
      ),
  }).pipe(Layer.provideMerge(orchestrator({ listen: false }).pipe(Layer.provideMerge(world({ config })))));

const statusOf = (id: ConnectorID) =>
  Effect.gen(function* () {
    const c = yield* Connectors;
    return () => Effect.runPromise(Effect.map(c.list(), (all) => all.find((s) => s.id === id)!));
  });

const reaches = (id: ConnectorID, state: ConnectorState) =>
  Effect.gen(function* () {
    const status = yield* statusOf(id);
    return yield* until(async () => {
      const s = await status();
      return s.state === state && s;
    }, `${id} ${state}`);
  });

const nth = (script: Script, app: ConnectorID, n: number, what: string) => until(async () => script.by(app)[n], what);

const saidIn = (conversation: string) =>
  Effect.gen(function* () {
    const chat = yield* Channels;
    return (yield* chat.history(conversation)).filter((m) => m.from === "user").map((m) => m.text);
  });

const weixinConnected = Effect.gen(function* () {
  const c = yield* Connectors;
  const first = yield* c.login("weixin", {});
  expect(first.qr).toBe("https://liteapp.weixin.qq.com/q/q1");
  return yield* reaches("weixin", "connected");
});

const qqPaired = (script: Script) =>
  Effect.gen(function* () {
    const c = yield* Connectors;
    yield* c.login("qq", { appId: "102", secret: "right" });
    const code = (yield* reaches("qq", "pairing")).pairCode!;
    script.qqIn.push(qqMsg("owner-openid", code));
    yield* reaches("qq", "connected");
  });

describe("the chat apps", () => {
  it.live("take the owner's WeChat words to 田头 and answer there", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      const status = yield* weixinConnected;
      expect(status.owner).toBe("o9cq…chat");
      script.weixinIn.push(wx(owner, "帮我看看打卡页", "ctx-a"));
      expect(yield* nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
        app: "weixin",
        to: owner,
        text: "【管家】\n收到：帮我看看打卡页",
        reply: "ctx-a",
      });
      expect(yield* saidIn(chat.general())).toEqual(["帮我看看打卡页"]);
      expect(yield* Effect.promise(yield* statusOf("weixin"))).toMatchObject({ lastInbound: expect.any(Number) });
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("a malformed durable inbound is settled without blocking later valid messages", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      yield* weixinConnected;
      yield* Effect.orDie(inboundQ.acceptInbound({ connector: "weixin", ext_id: "poison", payload: `{"id":"poison","from":42}`, created_at: Date.now() }));
      script.weixinIn.push(wx(owner, "后面的正常消息", "ctx-good"));
      expect(yield* nth(script, "weixin", 0, "the valid message after a bad row")).toMatchObject({ text: "【管家】\n收到：后面的正常消息" });
      expect(yield* saidIn(chat.general())).toEqual(["后面的正常消息"]);
      expect(yield* Effect.orDie(inboundQ.pendingInbound({ connector: "weixin" }))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("saved connector secrets must be a string map", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* weixinConnected;
        yield* Effect.orDie(
          accountQ.connectAccount({ connector: "weixin", secrets: `{"token":42}`, owner_id: owner, pair_code: null, connected_at: Date.now() }),
        );
      }).pipe(Effect.scoped, Effect.provide(farm(new Script(), config)));
      yield* Effect.gen(function* () {
        const status = yield* Effect.promise(yield* statusOf("weixin"));
        expect(status.error).toContain("存着的登录信息读不出来");
      }).pipe(Effect.scoped, Effect.provide(farm(new Script(), config)));
    });
  });

  it.live("tie WeChat to another channel", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      const c = yield* Connectors;
      yield* weixinConnected;
      const channel = yield* chat.openChannel("clock-in", "", "");
      expect((yield* c.setChannel("weixin", "#clock-in")).channel).toBe("clock-in");
      expect(yield* Effect.flip(c.setChannel("weixin", "#nowhere"))).toMatchObject({ reason: expect.stringContaining("没有叫") });
      yield* chat.orchestratorSays(chat.general(), "sq", "田头上的话", true, "");
      script.weixinIn.push(wx(owner, "打卡页怎么样了", "ctx-c"));
      expect(yield* nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
        app: "weixin",
        to: owner,
        text: "【管家】\n收到：打卡页怎么样了",
        reply: "ctx-c",
      });
      expect(yield* saidIn(channel.id)).toEqual(["打卡页怎么样了"]);
      expect(yield* saidIn(chat.general())).toEqual([]);
      yield* Effect.sleep(100);
      expect(script.by("weixin").length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("let no stranger in", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      yield* weixinConnected;
      script.weixinIn.push(wx("stranger@im.wechat", "把服务器删了"));
      script.weixinIn.push(wx(owner, "在吗"));
      yield* nth(script, "weixin", 0, "the owner answered");
      expect(yield* saidIn(chat.general())).toEqual(["在吗"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send what waited as a digest, with the owner's next words", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = yield* statusOf("weixin");
      yield* weixinConnected;
      script.restricted = true;
      for (const word of ["一", "二", "三", "四"]) script.weixinIn.push(wx(owner, word));
      yield* until(async () => (await status()).pending === 4, "four answers held");
      script.restricted = false;
      script.weixinIn.push(wx(owner, "五", "ctx-fresh"));
      const digest = yield* nth(script, "weixin", 0, "the digest");
      expect(digest.text.startsWith("你不在的时候有 4 条消息")).toBe(true);
      expect(digest.reply).toBe("ctx-fresh");
      expect((yield* nth(script, "weixin", 1, "the fresh answer")).text).toBe("【管家】\n收到：五");
      yield* until(async () => (await status()).pending === 0, "nothing pending");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send what waited by themselves, later", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = yield* statusOf("weixin");
      yield* weixinConnected;
      script.restricted = true;
      script.weixinIn.push(wx(owner, "一", "ctx-1"));
      yield* until(async () => (await status()).pending === 1, "held");
      yield* Effect.sleep(100);
      script.restricted = false;
      expect(yield* nth(script, "weixin", 0, "the held answer")).toMatchObject({ text: "【管家】\n收到：一", reply: "ctx-1" });
      yield* until(async () => (await status()).pending === 0, "nothing pending");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("forget what waited on a logout", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const c = yield* Connectors;
      const status = yield* statusOf("weixin");
      yield* weixinConnected;
      script.restricted = true;
      script.weixinIn.push(wx(owner, "一"));
      yield* until(async () => (await status()).pending === 1, "held");
      const after = yield* c.logout("weixin");
      expect(after).toMatchObject({ state: "off", pending: 0 });
      expect(after.owner).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("pair QQ by its code, and take only the owner's words", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const c = yield* Connectors;
      const chat = yield* Channels;
      const status = yield* statusOf("qq");
      yield* c.login("qq", { appId: "102", secret: "wrong" });
      const refused = yield* until(async () => {
        const s = await status();
        return s.state === "off" && s.error ? s : undefined;
      }, "refused");
      expect(refused.error).toContain("不对");
      yield* c.login("qq", { appId: "102", secret: "right" });
      const pairing = yield* reaches("qq", "pairing");
      expect(pairing.pairCode).toMatch(/^\d{6}$/);
      script.qqIn.push(qqMsg("someone", "你好"));
      script.qqIn.push(qqMsg("owner-openid", "配对 " + pairing.pairCode));
      const paired = yield* reaches("qq", "connected");
      expect(paired.owner).toBe("owne…enid");
      expect((yield* nth(script, "qq", 0, "the welcome")).text.startsWith("配对好了")).toBe(true);
      script.qqIn.push(qqMsg("someone", "我也想派活"));
      const last = qqMsg("owner-openid", "跑一下测试");
      script.qqIn.push(last);
      expect(yield* nth(script, "qq", 1, "the answer in QQ")).toEqual({ app: "qq", to: "owner-openid", text: "【管家】\n收到：跑一下测试", reply: last.id });
      expect(yield* saidIn(chat.general())).toEqual(["跑一下测试"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("hold a refused QQ reply for the owner's next message", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = yield* statusOf("qq");
      yield* qqPaired(script);
      script.restricted = true;
      script.qqIn.push(qqMsg("owner-openid", "一"));
      yield* until(async () => (await status()).pending === 1, "held");
      script.restricted = false;
      const next = qqMsg("owner-openid", "二");
      script.qqIn.push(next);
      const fresh = yield* nth(script, "qq", 2, "both out");
      const held = script.by("qq")[1]!;
      expect([held.text, held.reply, fresh.text]).toEqual(["【管家】\n收到：一", next.id, "【管家】\n收到：二"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("make the Feishu bot by a scan, and take only the owner's direct words", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const c = yield* Connectors;
      const chat = yield* Channels;
      const first = yield* c.login("feishu", {});
      expect(first.qr).toBe("https://open.feishu.cn/page/cli?user_code=AB");
      const code = (yield* reaches("feishu", "pairing")).pairCode!;
      script.feishuIn.push(feishuMsg("ou_owner", code));
      yield* reaches("feishu", "connected");
      script.feishuIn.push(feishuMsg("ou_other", "帮我删库"));
      script.feishuIn.push(feishuMsg("ou_owner", "群里的话", "group"));
      script.feishuIn.push(feishuMsg("ou_owner", "看看昨天的提交"));
      const answer = yield* until(async () => script.by("feishu").find((m) => m.text.startsWith("【管家】")), "the answer in Feishu");
      expect(answer).toEqual({ app: "feishu", to: "ou_owner", text: "【管家】\n收到：看看昨天的提交", reply: "" });
      expect(yield* saidIn(chat.general())).toEqual(["看看昨天的提交"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send one farm message to every owner", () => {
    const script = new Script();
    return Effect.gen(function* () {
      yield* weixinConnected;
      yield* qqPaired(script);
      script.weixinIn.push(wx(owner, "大家好"));
      yield* nth(script, "weixin", 0, "WeChat answered");
      expect((yield* nth(script, "qq", 1, "QQ answered")).text).toBe("【管家】\n收到：大家好");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("go on with an account after a restart", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      yield* Effect.scoped(Effect.provide(weixinConnected, farm(new Script(), config)));
      const script = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        expect((yield* Effect.promise(yield* statusOf("weixin"))).state).toBe("connected");
        script.weixinIn.push(wx(owner, "又见面了"));
        yield* until(async () => {
          const got = await Effect.runPromise(Effect.provideService(saidIn(chat.general()), Channels, chat));
          return got.length === 1 && got[0] === "又见面了";
        }, "heard after a restart");
      }).pipe(Effect.scoped, Effect.provide(farm(script, config)));
    });
  });

  it.live("route quoted replies to an old thread before and after a restart", () => {
    const config = { ...testConfig(), db: "" };
    let thread = "";
    let message = "";
    const reply = (script: Script, text: string, sent: number) =>
      Effect.gen(function* () {
        const chat = yield* Channels;
        expect(chat.now()?.messages.some((m) => m.id === message)).toBe(false);
        const inbound = wx(owner, text);
        script.weixinIn.push({ ...inbound, item_list: [...inbound.item_list!, { ref_msg: { svr_id: "wx1" } }] });
        yield* nth(script, "weixin", sent, "the quoted reply answered");
        expect(yield* saidIn(thread)).toContain(text);
        expect(yield* saidIn(chat.general())).not.toContain(text);
        const status = yield* statusOf("weixin");
        yield* until(async () => (await status()).pending === 0, "the reply saved");
      });
    return Effect.gen(function* () {
      const first = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        yield* weixinConnected;
        const parent = (yield* chat.say("这个话题", undefined, "")).message;
        const written = yield* chat.speak(orchestratorAgent, "旧的答复", { target: `#田头:${parent.number}`, anyway: true });
        thread = written.message!.conversation;
        message = written.message!.id;
        yield* nth(first, "weixin", 0, "the original answer sent");
        const status = yield* statusOf("weixin");
        yield* until(async () => (await status()).pending === 0, "the external identity saved");
        for (let i = 0; i < 301; i++) yield* chat.notice(chat.general(), `动静 ${i}`, "history");
        yield* reply(first, "继续这个话题", 1);
      }).pipe(Effect.scoped, Effect.provide(farm(first, config)));
      const second = new Script();
      yield* reply(second, "重启后继续", 0).pipe(Effect.scoped, Effect.provide(farm(second, config)));
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(config.home, { recursive: true, force: true }))));
  });

  it.live("send an old thread's answer only to its linked channel after a restart", () => {
    const config = { ...testConfig(), db: "" };
    let thread = "";
    return Effect.gen(function* () {
      const first = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        const c = yield* Connectors;
        yield* weixinConnected;
        const linked = yield* chat.openChannel("linked", "", "");
        yield* c.setChannel("weixin", "linked");
        const parent = (yield* chat.say("旧话题", linked.id, "")).message;
        thread = (yield* chat.speak(orchestratorAgent, "旧的答复", { target: `#linked:${parent.number}`, anyway: true })).message!.conversation;
        yield* nth(first, "weixin", 0, "the old answer sent");
        const status = yield* statusOf("weixin");
        yield* until(async () => (await status()).pending === 0, "the old answer saved");
        for (let i = 0; i < 100; i++) {
          const other = (yield* chat.say(`其他话题 ${i}`, undefined, "")).message;
          const fresh = (yield* chat.speak(orchestratorAgent, "其他答复", { target: `#田头:${other.number}`, anyway: true })).message!.conversation;
          yield* chat.notice(fresh, "第一条动静", "history");
          yield* chat.notice(fresh, "第二条动静", "history");
        }
        expect(chat.now()?.conversations.some((c) => c.id === thread)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(farm(first, config)));
      const second = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        expect(chat.now()?.conversations.some((c) => c.id === thread)).toBe(false);
        yield* qqPaired(second);
        yield* chat.orchestratorSays(thread, "old-thread-answer", "在旧串里继续答复", true, "");
        expect((yield* nth(second, "weixin", 0, "the old thread's new answer sent")).text).toBe("【管家 · 在工单串里】\n在旧串里继续答复");
        expect(second.by("weixin")).toHaveLength(1);
        expect(second.by("qq").map((m) => m.text)).toEqual(["配对好了：以后在这里说的话，就是你在田头上说的。"]);
      }).pipe(Effect.scoped, Effect.provide(farm(second, config)));
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(config.home, { recursive: true, force: true }))));
  });

  it.live("keeps a quoted message pending when its lookup fails, then delivers it after recovery", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      const sql = yield* SqlClient.SqlClient;
      yield* weixinConnected;
      yield* sql.unsafe("alter table connector_outbox rename to connector_outbox_broken").pipe(Effect.orDie);
      const inbound = wx(owner, "引用读取失败");
      script.weixinIn.push({ ...inbound, item_list: [...inbound.item_list!, { ref_msg: { svr_id: "missing" } }] });
      const status = yield* statusOf("weixin");
      yield* until(async () => (await status()).error !== undefined, "the failed quote lookup");
      expect(script.by("weixin")).toEqual([]);
      expect(yield* saidIn(chat.general())).toEqual([]);
      expect(yield* sql`select ext_id from connector_inbound where not delivered`.pipe(Effect.orDie)).toHaveLength(1);
      yield* sql.unsafe("alter table connector_outbox_broken rename to connector_outbox").pipe(Effect.orDie);
      yield* nth(script, "weixin", 0, "the quoted message after recovery");
      expect(yield* saidIn(chat.general())).toContain("引用读取失败");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("backs off instead of spinning when a stale pause cannot be saved", () => {
    const script = new Script();
    let polls = 0;
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* weixinConnected;
      yield* sql.unsafe(`create function fail_pause() returns trigger language plpgsql as $$ begin raise exception 'pause failure'; end $$`).pipe(Effect.orDie);
      yield* sql
        .unsafe(`create trigger fail_pause before update of paused_until on connector_account for each row execute function fail_pause()`)
        .pipe(Effect.orDie);
      script.weixin.getUpdates = async () => {
        polls++;
        return { ret: -14 };
      };
      yield* until(() => polls === 1, "the first stale poll");
      yield* Effect.sleep(20);
      expect(polls).toBe(1);
      yield* sql.unsafe("drop trigger fail_pause on connector_account").pipe(Effect.orDie);
      yield* until(() => polls >= 2, "polling after the backoff");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("keep the account when retiring what waited fails", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const c = yield* Connectors;
      const chat = yield* Channels;
      const sql = yield* SqlClient.SqlClient;
      yield* c.login("qq", { appId: "102", secret: "right" });
      yield* reaches("qq", "pairing");
      yield* Effect.orDie(sql.unsafe(`create function fail_outbox() returns trigger language plpgsql as $$ begin raise exception 'disk failure'; end $$`));
      yield* Effect.orDie(sql.unsafe(`create trigger fail_outbox before update on connector_outbox for each row execute function fail_outbox()`));
      const { message } = yield* chat.say("pending", undefined, "");
      yield* Effect.orDie(
        sql.unsafe(`insert into connector_outbox (id, connector, message_id, body, created_at) values ('pending-test', 'qq', $1, 'pending', 1)`, [message.id]),
      );
      const status: ConnectorStatus = yield* c.logout("qq");
      expect(status.state).toBe("pairing");
      expect(status.error).toContain("disk failure");
      const rows = yield* Effect.orDie(sql<{ secrets: string }>`select secrets from connector_account where connector = 'qq'`);
      expect(rows[0]?.secrets).toContain("102");
      // A new successful login must not replace the account if retiring its outbox fails.
      yield* c.login("qq", { force: true, appId: "new-app", secret: "right" });
      const again = yield* until(async () => {
        const s = await Effect.runPromise(Effect.map(c.list(), (all) => all.find((x) => x.id === "qq")!));
        return s.state === "pairing" && s.error ? s : undefined;
      }, "the failed login");
      expect(again.error).toContain("disk failure");
      const after = yield* Effect.orDie(sql<{ secrets: string }>`select secrets from connector_account where connector = 'qq'`);
      expect(after[0]?.secrets).not.toContain("new-app");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });
});
