import { rmSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { type ConnectorID, type ConnectorState, type ConnectorStatus, defaultOrchestrator } from "@vibevalley/protocol";

import { Channels } from "@/channel/chat.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";
import { testConfig } from "@/testing/layers.ts";
import { gate, untilGot as until, waitFor, whenState } from "@/testing/until.ts";
import { world } from "@/testing/world.ts";

import * as accountQ from "../../db/generated/connector_account.sql.ts";
import * as inboundQ from "../../db/generated/connector_inbound.sql.ts";
import { AppFailed, failedWith } from "./adapter.ts";
import { Connectors } from "./connector.ts";
import type { FeishuApi, Message as FeishuMessage } from "./feishu.ts";
import { type QQApi, type Message as QQMessage } from "./qq.ts";
import { type Message as WeixinMessage, type Updates, type WeixinApi, baseUrl } from "./weixin.ts";

const owner = "o9cq80wkM5NnOwnerOfThisFarm@im.wechat";

interface Sent {
  readonly app: ConnectorID;
  readonly to: string;
  readonly text: string;
  readonly reply: string;
}

/** Messages waiting to be taken, one at a time: a take waits, as a long poll does, until one is pushed or it is called off. */
class Inbox<A> {
  private readonly queue = Effect.runSync(Queue.unbounded<A>());
  private ended = Deferred.makeUnsafe<void>();
  push(a: A) {
    Queue.offerUnsafe(this.queue, a);
  }
  /** Ends the poll waiting now with nothing, as the platform's long poll does in time. */
  end() {
    Deferred.doneUnsafe(this.ended, Effect.void);
    this.ended = Deferred.makeUnsafe<void>();
  }
  readonly take: Effect.Effect<A | undefined> = Effect.suspend(() =>
    Effect.raceFirst(Queue.take(this.queue), Effect.as(Deferred.await(this.ended), undefined)),
  );
}

/** Until the test opens the gate; a login called off first is interrupted there. */
const past = (g: { readonly opened: Promise<void> }) => Effect.promise(() => g.opened);

/** The three apps, played: what they are sent is kept; restricted, they refuse a reply as an expired window does, but
 * one to a message the owner has just sent (opened), as the real window opens again. */
class Script {
  readonly sent: Sent[] = [];
  restricted = false;
  /** The reply context of the owner's fresh message: a reply to it goes through while restricted. */
  opened = "";
  private refuses = (reply: string) => this.restricted && reply !== this.opened;
  readonly weixinIn = new Inbox<WeixinMessage>();
  readonly feishuIn = new Inbox<FeishuMessage>();
  readonly qqIn = new Inbox<QQMessage>();
  /** Each app's code is scanned once the test opens its gate, after it has seen the code. */
  readonly weixinScan = gate();
  readonly feishuScan = gate();
  private record(s: Sent) {
    this.sent.push(s);
    return this.sent.length;
  }
  by = (app: ConnectorID) => this.sent.filter((s) => s.app === app);
  /** WeChat's long poll: the next message, or nothing when the poll is ended; a test may answer otherwise. */
  updates = (buf: string): Effect.Effect<Updates> =>
    Effect.map(this.weixinIn.take, (m) => (m ? { ret: 0, msgs: [m], get_updates_buf: buf + "+" } : { ret: 0, get_updates_buf: buf }));

  readonly weixin: WeixinApi = {
    login: (progress) =>
      Effect.gen({ self: this }, function* () {
        yield* progress("waiting", "https://liteapp.weixin.qq.com/q/q1");
        yield* past(this.weixinScan);
        yield* progress("scanned", "https://liteapp.weixin.qq.com/q/q1");
        return { account: { baseUrl, token: "tok" }, botId: "bot1@im.bot", owner };
      }),
    getUpdates: (_account, buf) => Effect.suspend(() => this.updates(buf)),
    sendText: (_account, to, text, contextToken) =>
      this.refuses(contextToken)
        ? Effect.fail(new AppFailed({ kind: "restricted", message: "sendmessage: -2" }))
        : Effect.sync(() => "wx" + this.record({ app: "weixin", to, text, reply: contextToken })),
  };

  readonly feishu: FeishuApi = {
    login: (progress) =>
      Effect.gen({ self: this }, function* () {
        yield* progress("https://open.feishu.cn/page/cli?user_code=AB");
        yield* past(this.feishuScan);
        return { app: { appId: "cli_1", appSecret: "s", domain: "feishu" as const }, owner: "" };
      }),
    listen: (_app, got) => Effect.forever(Effect.flatMap(this.feishuIn.take, (m) => (m ? got(m) : Effect.void))),
    sendText: (_app, openId, text) => Effect.sync(() => "om_" + this.record({ app: "feishu", to: openId, text, reply: "" })),
  };

  readonly qq: QQApi = {
    check: (app) => (app.secret !== "right" ? Effect.fail(failedWith("QQ 鉴权：AppID 或 AppSecret 不对")) : Effect.void),
    listen: (_app, got) => Effect.forever(Effect.flatMap(this.qqIn.take, (m) => (m ? got(m) : Effect.void))),
    sendText: (_app, openId, text, msgId) =>
      this.refuses(msgId)
        ? Effect.fail(new AppFailed({ kind: "restricted", message: "QQ 发消息：被动回复超时" }))
        : Effect.sync(() => "qq" + this.record({ app: "qq", to: openId, text, reply: msgId })),
  };
}

let ids = 100;
const wx = (who: string, text: string, context = ""): WeixinMessage => {
  const id = ++ids;
  return {
    message_id: String(id),
    from_user_id: who,
    message_type: 1,
    context_token: context || `ctx-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
};
const qqMsg = (from: string, content: string): QQMessage => ({
  id: `qm${++ids}`,
  from,
  content,
  attachments: 0,
});
const feishuMsg = (from: string, text: string, chatType = "p2p"): FeishuMessage => ({
  messageId: `om${++ids}`,
  from,
  chatType,
  messageType: "text",
  content: JSON.stringify({ text }),
  parentId: "",
});

/** The orchestrator, played: what it hears goes into the channel, and it answers 收到 at once. */
const farm = (script: Script, config = testConfig(), retry: { retryFirstMs?: number; retryMostMs?: number } = {}) =>
  Connectors.layer({
    weixin: script.weixin,
    feishu: script.feishu,
    qq: script.qq,
    ...retry,
    say: (text, channel, sendKey, chat) =>
      Effect.flatMap(chat.say(text, channel, sendKey), ({ message, again }) =>
        again ? Effect.void : chat.orchestratorSays(message.channel, "收到：**" + text + "**", "", defaultOrchestrator),
      ),
  }).pipe(Layer.provideMerge(Orchestrator.layer({ listen: false }).pipe(Layer.provideMerge(world({ config })))));

const statusOf = (id: ConnectorID) =>
  Effect.gen(function* () {
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const c = yield* Connectors;
    return () => runPromise(Effect.map(c.list(), (all) => all.find((s) => s.id === id)!));
  });

/** The chat app's status once ok holds for it, as the connectors say it to the core whenever it changes. */
const statusIs = (id: ConnectorID, ok: (s: ConnectorStatus) => boolean, what: string) =>
  whenState((state) => {
    const s = state.connectors.find((c) => c.id === id);
    return s && ok(s) ? s : undefined;
  }, `${id}: ${what}`);

const reaches = (id: ConnectorID, state: ConnectorState) => statusIs(id, (s) => s.state === state, state);

const nth = (script: Script, app: ConnectorID, n: number, what: string) => until(async () => script.by(app)[n], what);

const saidIn = (channel: string) =>
  Effect.gen(function* () {
    const chat = yield* Channels;
    return (yield* chat.history(channel)).filter((m) => m.from === "owner").map((m) => m.text);
  });

const weixinConnected = (script: Script) =>
  Effect.gen(function* () {
    const c = yield* Connectors;
    const first = yield* c.login("weixin", {});
    expect(first.qr).toBe("https://liteapp.weixin.qq.com/q/q1");
    script.weixinScan.open();
    return yield* reaches("weixin", "connected");
  });

const qqPaired = (script: Script) =>
  Effect.gen(function* () {
    const c = yield* Connectors;
    yield* c.login("qq", { appId: "102", secret: "right" });
    const code = (yield* reaches("qq", "pairing")).pairCode;
    script.qqIn.push(qqMsg("owner-openid", code));
    yield* reaches("qq", "connected");
  });

describe("the chat apps", () => {
  it.live("take the owner's WeChat words to the default channel and answer there", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      const status = yield* weixinConnected(script);
      expect(status.owner).toBe("o9cq…chat");
      script.weixinIn.push(wx(owner, "帮我看看打卡页", "ctx-a"));
      expect(yield* nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
        app: "weixin",
        to: owner,
        text: "【管家】\n收到：帮我看看打卡页",
        reply: "ctx-a",
      });
      expect(yield* saidIn(chat.defaultChannel())).toEqual(["帮我看看打卡页"]);
      expect(yield* Effect.promise(yield* statusOf("weixin"))).toMatchObject({
        lastInbound: expect.any(Number),
      });
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("a malformed durable inbound is settled without blocking later valid messages", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      yield* weixinConnected(script);
      yield* Effect.orDie(
        inboundQ.acceptInbound({
          connector: "weixin",
          ext_id: "poison",
          payload: `{"id":"poison","from":42}`,
          created_at: Date.now(),
        }),
      );
      script.weixinIn.push(wx(owner, "后面的正常消息", "ctx-good"));
      expect(yield* nth(script, "weixin", 0, "the valid message after a bad row")).toMatchObject({
        text: "【管家】\n收到：后面的正常消息",
      });
      expect(yield* saidIn(chat.defaultChannel())).toEqual(["后面的正常消息"]);
      // Settled once the words are in, which is after the answer went out.
      yield* waitFor(Effect.orDie(inboundQ.pendingInbound({ connector: "weixin" })), (rows) => rows.length === 0, "both rows settled");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("saved connector secrets must be a string map", () => {
    const config = { ...testConfig(), db: "" };
    const first = new Script();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* weixinConnected(first);
        yield* Effect.orDie(
          accountQ.connectAccount({
            connector: "weixin",
            secrets: `{"token":42}`,
            owner_id: owner,
            pair_code: null,
            connected_at: Date.now(),
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(farm(first, config)));
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
      yield* weixinConnected(script);
      const channel = yield* chat.openChannel("clock-in", "", "");
      expect((yield* c.setChannel("weixin", "#clock-in")).channel).toBe("clock-in");
      expect(yield* Effect.flip(c.setChannel("weixin", "#nowhere"))).toMatchObject({
        reason: expect.stringContaining("没有叫"),
      });
      yield* chat.orchestratorSays(chat.defaultChannel(), "默认频道里的话", "", defaultOrchestrator);
      script.weixinIn.push(wx(owner, "打卡页怎么样了", "ctx-c"));
      expect(yield* nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
        app: "weixin",
        to: owner,
        text: "【管家】\n收到：打卡页怎么样了",
        reply: "ctx-c",
      });
      expect(yield* saidIn(channel.id)).toEqual(["打卡页怎么样了"]);
      expect(yield* saidIn(chat.defaultChannel())).toEqual([]);
      // What goes out is offered in the order it was said: the answer is out, so the default channel's earlier words were weighed and
      // kept from WeChat.
      expect(script.by("weixin").length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("let no stranger in", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      yield* weixinConnected(script);
      script.weixinIn.push(wx("stranger@im.wechat", "把服务器删了"));
      script.weixinIn.push(wx(owner, "在吗"));
      yield* nth(script, "weixin", 0, "the owner answered");
      expect(yield* saidIn(chat.defaultChannel())).toEqual(["在吗"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send what waited as a digest, with the owner's next words", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
      yield* weixinConnected(script);
      script.restricted = true;
      for (const word of ["一", "二", "三", "四"]) script.weixinIn.push(wx(owner, word));
      yield* status((s) => s.pending === 4, "four answers held");
      // The owner's next words open the window again: whatever was tried before was refused, whenever it was tried.
      script.opened = "ctx-fresh";
      script.weixinIn.push(wx(owner, "五", "ctx-fresh"));
      const digest = yield* nth(script, "weixin", 0, "the digest");
      expect(digest.text.startsWith("你不在的时候有 4 条消息")).toBe(true);
      expect(digest.reply).toBe("ctx-fresh");
      expect((yield* nth(script, "weixin", 1, "the fresh answer")).text).toBe("【管家】\n收到：五");
      yield* status((s) => s.pending === 0, "nothing pending");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send what waited by themselves, later", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
      yield* weixinConnected(script);
      script.restricted = true;
      script.weixinIn.push(wx(owner, "一", "ctx-1"));
      yield* status((s) => s.pending === 1, "held");
      script.restricted = false;
      expect(yield* nth(script, "weixin", 0, "the held answer")).toMatchObject({
        text: "【管家】\n收到：一",
        reply: "ctx-1",
      });
      yield* status((s) => s.pending === 0, "nothing pending");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("forget what waited on a logout", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const c = yield* Connectors;
      const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
      yield* weixinConnected(script);
      script.restricted = true;
      script.weixinIn.push(wx(owner, "一"));
      yield* status((s) => s.pending === 1, "held");
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
      yield* c.login("qq", { appId: "102", secret: "wrong" });
      const refused = yield* statusIs("qq", (s) => s.state === "off" && !!s.error, "refused");
      expect(refused.error).toContain("不对");
      yield* c.login("qq", { appId: "102", secret: "right" });
      const pairing = yield* reaches("qq", "pairing");
      expect(pairing.pairCode).toMatch(/^\d{6}$/u);
      script.qqIn.push(qqMsg("someone", "你好"));
      script.qqIn.push(qqMsg("owner-openid", "配对 " + pairing.pairCode));
      const paired = yield* reaches("qq", "connected");
      expect(paired.owner).toBe("owne…enid");
      expect((yield* nth(script, "qq", 0, "the welcome")).text.startsWith("配对好了")).toBe(true);
      script.qqIn.push(qqMsg("someone", "我也想派活"));
      const last = qqMsg("owner-openid", "跑一下测试");
      script.qqIn.push(last);
      expect(yield* nth(script, "qq", 1, "the answer in QQ")).toEqual({
        app: "qq",
        to: "owner-openid",
        text: "【管家】\n收到：跑一下测试",
        reply: last.id,
      });
      expect(yield* saidIn(chat.defaultChannel())).toEqual(["跑一下测试"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.effect("a QQ gateway that fails mid-message: what it was handing over arrives, a late handover is refused, and it listens again", () => {
    const script = new Script();
    let listens = 0;
    let late: ((m: QQMessage) => Effect.Effect<void, AppFailed>) | undefined;
    const qq = script.qq;
    // The SDK's handler can outlive its listen: this one keeps got, and fails the gateway once a message is handed over.
    (script as { qq: QQApi }).qq = {
      ...script.qq,
      listen: (app, got) => {
        listens++;
        return qq.listen(app, (m) => {
          if (m.content !== "断开") return got(m);
          late = got;
          return Effect.andThen(got(qqMsg("owner-openid", "断开前的一句")), Effect.fail(failedWith("网关断了")));
        });
      },
    };
    return Effect.gen(function* () {
      const chat = yield* Channels;
      yield* qqPaired(script);
      const before = listens;
      script.qqIn.push(qqMsg("owner-openid", "断开"));
      // A failed receive is tried again after its backoff on the farm's Clock: moved through each time it is asked, as
      // the test cannot see when the backoff starts. The same account listens once more.
      yield* waitFor(
        Effect.map(TestClock.adjust(2_000), () => listens),
        (n) => n > before,
        "it listens again",
      );
      expect(yield* saidIn(chat.defaultChannel())).toContain("断开前的一句");
      const refused = yield* Effect.flip(late!(qqMsg("owner-openid", "迟到的一句")));
      expect(refused.message).toBe("canceled");
      script.qqIn.push(qqMsg("owner-openid", "重连后的一句"));
      yield* waitFor(saidIn(chat.defaultChannel()), (said) => said.includes("重连后的一句"), "the next words");
      expect(yield* saidIn(chat.defaultChannel())).not.toContain("迟到的一句");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("hold a refused QQ reply for the owner's next message", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("qq", ok, what);
      yield* qqPaired(script);
      script.restricted = true;
      script.qqIn.push(qqMsg("owner-openid", "一"));
      yield* status((s) => s.pending === 1, "held");
      const next = qqMsg("owner-openid", "二");
      script.opened = next.id;
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
      script.feishuScan.open();
      const code = (yield* reaches("feishu", "pairing")).pairCode;
      script.feishuIn.push(feishuMsg("ou_owner", code));
      yield* reaches("feishu", "connected");
      script.feishuIn.push(feishuMsg("ou_other", "帮我删库"));
      script.feishuIn.push(feishuMsg("ou_owner", "群里的话", "group"));
      script.feishuIn.push(feishuMsg("ou_owner", "看看昨天的提交"));
      const answer = yield* until(async () => script.by("feishu").find((m) => m.text.startsWith("【管家】")), "the answer in Feishu");
      expect(answer).toEqual({
        app: "feishu",
        to: "ou_owner",
        text: "【管家】\n收到：看看昨天的提交",
        reply: "",
      });
      expect(yield* saidIn(chat.defaultChannel())).toEqual(["看看昨天的提交"]);
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("send one farm message to every owner", () => {
    const script = new Script();
    return Effect.gen(function* () {
      yield* weixinConnected(script);
      yield* qqPaired(script);
      script.weixinIn.push(wx(owner, "大家好"));
      yield* nth(script, "weixin", 0, "WeChat answered");
      expect((yield* nth(script, "qq", 1, "QQ answered")).text).toBe("【管家】\n收到：大家好");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });

  it.live("go on with an account after a restart", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      const before = new Script();
      yield* Effect.scoped(Effect.provide(weixinConnected(before), farm(before, config)));
      const script = new Script();
      yield* Effect.gen(function* () {
        const runPromise = Effect.runPromiseWith(yield* Effect.context());
        const chat = yield* Channels;
        expect((yield* Effect.promise(yield* statusOf("weixin"))).state).toBe("connected");
        script.weixinIn.push(wx(owner, "又见面了"));
        yield* until(async () => {
          const got = await runPromise(Effect.provideService(saidIn(chat.defaultChannel()), Channels, chat));
          return got.length === 1 && got[0] === "又见面了";
        }, "heard after a restart");
      }).pipe(Effect.scoped, Effect.provide(farm(script, config)));
    });
  });

  it.live("route quoted replies to an old thread before and after a restart", () => {
    const config = { ...testConfig(), db: "" };
    let thread = "";
    const reply = (script: Script, text: string, sent: number) =>
      Effect.gen(function* () {
        const chat = yield* Channels;
        const inbound = wx(owner, text);
        script.weixinIn.push({
          ...inbound,
          item_list: [...inbound.item_list!, { ref_msg: { svr_id: "wx1" } }],
        });
        yield* nth(script, "weixin", sent, "the quoted reply answered");
        expect(yield* saidIn(thread)).toContain(text);
        expect(yield* saidIn(chat.defaultChannel())).not.toContain(text);
        const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
        yield* status((s) => s.pending === 0, "the reply saved");
      });
    return Effect.gen(function* () {
      const first = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        yield* weixinConnected(first);
        const parent = (yield* chat.say("这个话题", undefined, "")).message;
        const written = yield* chat.speak(defaultOrchestrator, "旧的答复", {
          target: `#general:${parent.number}`,
          anyway: true,
        });
        thread = written.message!.channel;
        yield* nth(first, "weixin", 0, "the original answer sent");
        const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
        yield* status((s) => s.pending === 0, "the external identity saved");
        for (let i = 0; i < 301; i++) yield* chat.notice(chat.defaultChannel(), `动静 ${i}`, "history");
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
        yield* weixinConnected(first);
        const linked = yield* chat.openChannel("linked", "", "");
        yield* c.setChannel("weixin", "linked");
        const parent = (yield* chat.say("旧话题", linked.id, "")).message;
        thread = (yield* chat.speak(defaultOrchestrator, "旧的答复", {
          target: `#linked:${parent.number}`,
          anyway: true,
        })).message!.channel;
        yield* nth(first, "weixin", 0, "the old answer sent");
        const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
        yield* status((s) => s.pending === 0, "the old answer saved");
        for (let i = 0; i < 100; i++) {
          const other = (yield* chat.say(`其他话题 ${i}`, undefined, "")).message;
          const fresh = (yield* chat.speak(defaultOrchestrator, "其他答复", {
            target: `#general:${other.number}`,
            anyway: true,
          })).message!.channel;
          yield* chat.notice(fresh, "第一条动静", "history");
          yield* chat.notice(fresh, "第二条动静", "history");
        }
        expect(chat.now()?.channels.some((c) => c.id === thread)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(farm(first, config)));
      const second = new Script();
      yield* Effect.gen(function* () {
        const chat = yield* Channels;
        expect(chat.now()?.channels.some((c) => c.id === thread)).toBe(false);
        yield* qqPaired(second);
        yield* chat.orchestratorSays(thread, "在旧串里继续答复", "", defaultOrchestrator);
        expect((yield* nth(second, "weixin", 0, "the old thread's new answer sent")).text).toBe("【管家 · 在工单串里】\n在旧串里继续答复");
        expect(second.by("weixin")).toHaveLength(1);
        expect(second.by("qq").map((m) => m.text)).toEqual(["配对好了：以后在这里说的话，就是你在默认频道里说的。"]);
      }).pipe(Effect.scoped, Effect.provide(farm(second, config)));
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(config.home, { recursive: true, force: true }))));
  });

  it.live("keeps a quoted message pending when its lookup fails, then delivers it after recovery", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const chat = yield* Channels;
      const sql = yield* SqlClient.SqlClient;
      yield* weixinConnected(script);
      yield* sql.unsafe("alter table connector_outbox rename to connector_outbox_broken").pipe(Effect.orDie);
      const inbound = wx(owner, "引用读取失败");
      script.weixinIn.push({
        ...inbound,
        item_list: [...inbound.item_list!, { ref_msg: { svr_id: "missing" } }],
      });
      const status = (ok: (s: ConnectorStatus) => boolean, what: string) => statusIs("weixin", ok, what);
      yield* status((s) => s.error !== "", "the failed quote lookup");
      expect(script.by("weixin")).toEqual([]);
      expect(yield* saidIn(chat.defaultChannel())).toEqual([]);
      expect(yield* sql`select ext_id from connector_inbound where not delivered`.pipe(Effect.orDie)).toHaveLength(1);
      yield* sql.unsafe("alter table connector_outbox_broken rename to connector_outbox").pipe(Effect.orDie);
      yield* nth(script, "weixin", 0, "the quoted message after recovery");
      expect(yield* saidIn(chat.defaultChannel())).toContain("引用读取失败");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("backs off instead of spinning when a stale pause cannot be saved", () => {
    const script = new Script();
    let polls = 0;
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* weixinConnected(script);
      yield* sql.unsafe(`create function fail_pause() returns trigger language plpgsql as $$ begin raise exception 'pause failure'; end $$`).pipe(Effect.orDie);
      yield* sql
        .unsafe(`create trigger fail_pause before update of paused_until on connector_account for each row execute function fail_pause()`)
        .pipe(Effect.orDie);
      script.updates = () =>
        Effect.sync(() => {
          polls++;
          return { ret: -14 };
        });
      script.weixinIn.end();
      yield* until(() => polls === 1, "the first stale poll");
      // Nothing to wait on shows it does not spin: a loop would poll again within this, the backoff (80 ms) not.
      // oxlint-disable-next-line vibevalley/no-test-sleep
      yield* Effect.sleep(20);
      expect(polls).toBe(1);
      yield* sql.unsafe("drop trigger fail_pause on connector_account").pipe(Effect.orDie);
      yield* until(() => polls >= 2, "polling after the backoff");
    }).pipe(Effect.scoped, Effect.provide(farm(script, testConfig(), { retryFirstMs: 20, retryMostMs: 80 })));
  });

  it.live("keep the account when retiring what waited fails", () => {
    const script = new Script();
    return Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context());
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
        const s = await runPromise(Effect.map(c.list(), (all) => all.find((x) => x.id === "qq")!));
        return s.state === "pairing" && s.error ? s : undefined;
      }, "the failed login");
      expect(again.error).toContain("disk failure");
      const after = yield* Effect.orDie(sql<{ secrets: string }>`select secrets from connector_account where connector = 'qq'`);
      expect(after[0]?.secrets).not.toContain("new-app");
    }).pipe(Effect.scoped, Effect.provide(farm(script)));
  });
});
