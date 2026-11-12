import { rmSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import { abortable, anySignal, Queue, reasonOf } from "@vibevalley/async";
import { type ConnectorID, type ConnectorState, type ConnectorStatus, defaultOrchestrator } from "@vibevalley/protocol";

import type { ServerConfig } from "#/infra/config.ts";
import type { Time } from "#/infra/time.ts";
import { gate, nextTurn, testConfig, until, untilGot, waitFor, whenState } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import { type World, world } from "#/testing/world.ts";
import * as accountQ from "#db/connector_account.sql.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";

import { AppFailed, failedWith } from "./adapter.ts";
import { type Connector, makeConnector } from "./connector.ts";
import type { FeishuApi, Message as FeishuMessage } from "./feishu.ts";
import { type QQApi, type Message as QQMessage } from "./qq.ts";
import { type Message as WeixinMessage, type Updates, type WeixinApi, baseUrl } from "./weixin.ts";

const user = "o9cq80wkM5NnUserOfThisFarm@im.wechat";

interface Sent {
  readonly app: ConnectorID;
  readonly to: string;
  readonly text: string;
  readonly reply: string;
}

/** The connector's clock, held still: it moves only when the test moves it, and every wait due by then wakes in order. */
function heldTime(start: number): Time & { readonly adjust: (ms: number) => Promise<void> } {
  let at = start;
  const sleepers = new Set<{ readonly until: number; readonly wake: () => void }>();
  const sleep = (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    if (ms <= 0) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const sleeper = { until: at + ms, wake: resolve };
    sleepers.add(sleeper);
    signal?.addEventListener(
      "abort",
      () => {
        sleepers.delete(sleeper);
        reject(reasonOf(signal));
      },
      { once: true },
    );
    return promise;
  };
  return {
    now: () => at,
    sleep,
    after: (ms, f) => {
      const stop = new AbortController();
      sleep(ms, stop.signal).then(f, () => undefined);
      return () => stop.abort();
    },
    adjust: async (ms) => {
      const end = at + ms;
      for (;;) {
        for (let i = 0; i < 5; i++) await nextTurn();
        const due = [...sleepers].filter((s) => s.until <= end).toSorted((a, b) => a.until - b.until)[0];
        if (due === undefined) break;
        sleepers.delete(due);
        at = due.until;
        due.wake();
      }
      at = end;
    },
  };
}

/** Messages waiting to be taken, one at a time: a take waits, as a long poll does, until one is pushed or it is called off. */
class Waiting<A> {
  private readonly queue = new Queue<A>();
  private ended = Promise.withResolvers<void>();
  push(a: A) {
    this.queue.offer(a);
  }
  /** Ends the poll waiting now with nothing, as the platform's long poll does in time. */
  end() {
    this.ended.resolve();
    this.ended = Promise.withResolvers<void>();
  }
  async take(signal?: AbortSignal): Promise<A | undefined> {
    const done = new AbortController();
    const both = anySignal(signal, done.signal);
    try {
      return await Promise.race([this.queue.take(both), this.ended.promise.then(() => undefined)]);
    } finally {
      done.abort();
    }
  }
}

/** Until the test opens the gate; a login called off first is aborted there. */
const past = (g: { readonly opened: Promise<void> }, signal: AbortSignal) => abortable(g.opened, signal);

/** The three apps, played: what they are sent is kept. */
class Script {
  readonly sent: Sent[] = [];
  restricted = false;
  /** The reply context of the user's fresh message: a reply to it goes through while restricted. */
  opened = "";
  private refuses = (reply: string) => this.restricted && reply !== this.opened;
  readonly weixinIn = new Waiting<WeixinMessage>();
  readonly feishuIn = new Waiting<FeishuMessage>();
  readonly qqIn = new Waiting<QQMessage>();
  /** Each app's code is scanned once the test opens its gate, after it has seen the code. */
  readonly weixinScan = gate();
  readonly feishuScan = gate();
  private record(s: Sent) {
    this.sent.push(s);
    return this.sent.length;
  }
  by = (app: ConnectorID) => this.sent.filter((s) => s.app === app);
  /** WeChat's long poll: the next message, or nothing when the poll is ended; a test may answer otherwise. */
  updates = async (buf: string, signal?: AbortSignal): Promise<Updates> => {
    const m = await this.weixinIn.take(signal);
    return m ? { ret: 0, msgs: [m], get_updates_buf: buf + "+" } : { ret: 0, get_updates_buf: buf };
  };

  readonly weixin: WeixinApi = {
    login: async (progress, _verification, signal) => {
      progress("waiting", "https://liteapp.weixin.qq.com/q/q1");
      await past(this.weixinScan, signal);
      progress("scanned", "https://liteapp.weixin.qq.com/q/q1");
      return { account: { baseUrl, token: "tok" }, botId: "bot1@im.bot", user };
    },
    getUpdates: (_account, buf, _timeout, signal) => this.updates(buf, signal),
    sendText: async (_account, to, text, contextToken) => {
      if (this.refuses(contextToken)) throw new AppFailed("restricted", "sendmessage: -2");
      return "wx" + this.record({ app: "weixin", to, text, reply: contextToken });
    },
  };

  readonly feishu: FeishuApi = {
    login: async (progress, signal) => {
      progress("https://open.feishu.cn/page/cli?user_code=AB");
      await past(this.feishuScan, signal);
      return { app: { appId: "cli_1", appSecret: "s", domain: "feishu" as const }, user: "" };
    },
    listen: async (_app, got, signal) => {
      for (;;) {
        const m = await this.feishuIn.take(signal);
        if (m) await got(m);
      }
    },
    sendText: async (_app, openId, text) => "om_" + this.record({ app: "feishu", to: openId, text, reply: "" }),
  };

  qq: QQApi = {
    check: async (app) => {
      if (app.secret !== "right") throw failedWith("QQ 鉴权：AppID 或 AppSecret 不对");
    },
    listen: async (_app, got, signal) => {
      for (;;) {
        const m = await this.qqIn.take(signal);
        if (m) await got(m);
      }
    },
    sendText: async (_app, openId, text, msgId) => {
      if (this.refuses(msgId)) throw new AppFailed("restricted", "QQ 发消息：被动回复超时");
      return "qq" + this.record({ app: "qq", to: openId, text, reply: msgId });
    },
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

/** The orchestrator consumer as the chat apps meet it here: each durable Mailbox input is answered at once. */
const echoing = (w: World) => {
  const news = w.inside.deliveries();
  const reading = (async () => {
    for await (const n of news)
      if (n._tag === "Handed")
        for (const message of n.messages)
          await w.channel.post({ _tag: "Run", from: defaultOrchestrator, channel: n.channel, text: "收到：**" + message.text + "**", run: "" });
  })();
  return async () => {
    news.close();
    await reading;
  };
};

interface ConnectorFarm extends AsyncDisposable {
  readonly world: World;
  readonly connector: Connector;
  readonly clock: ReturnType<typeof heldTime>;
}

/** The orchestrator, played: what it hears goes into the channel, and it answers acknowledged at once. */
const farm = async (
  script: Script,
  config: ServerConfig = testConfig(),
  retry: { retryFirstMs?: number; retryMostMs?: number } = {},
): Promise<ConnectorFarm> => {
  const w = await world({ config });
  const clock = heldTime(1_800_000_000_000);
  const stopEcho = echoing(w);
  const connector = await makeConnector({ ...w, clock }, { weixin: script.weixin, feishu: script.feishu, qq: script.qq, ...retry });
  return {
    world: w,
    connector,
    clock,
    [Symbol.asyncDispose]: async () => {
      await connector.close();
      await stopEcho();
      await w.close();
    },
  };
};

const statusOf = (f: ConnectorFarm, id: ConnectorID) => async () => (await f.connector.list()).find((s) => s.id === id)!;

/** The chat app's status once ok holds for it, as the connectors say it to the core whenever it changes. */
const statusIs = (f: ConnectorFarm, id: ConnectorID, ok: (s: ConnectorStatus) => boolean, what: string) =>
  whenState(
    f.world.core,
    (state) => {
      const s = state.connectors.find((c) => c.id === id);
      return s && ok(s) ? s : undefined;
    },
    `${id}: ${what}`,
  );

const reaches = (f: ConnectorFarm, id: ConnectorID, state: ConnectorState) => statusIs(f, id, (s) => s.state === state, state);

const nth = (script: Script, app: ConnectorID, n: number, what: string) => untilGot(async () => script.by(app)[n], what);

const saidIn = async (f: ConnectorFarm, channel: string) => (await f.world.channel.history(channel)).filter((m) => m.from === "user").map((m) => m.text);

const weixinConnected = async (f: ConnectorFarm, script: Script) => {
  const first = await f.connector.login("weixin", {});
  expect(first.qr).toBe("https://liteapp.weixin.qq.com/q/q1");
  script.weixinScan.open();
  return reaches(f, "weixin", "connected");
};

const qqPaired = async (f: ConnectorFarm, script: Script) => {
  await f.connector.login("qq", { appId: "102", secret: "right" });
  const code = (await reaches(f, "qq", "pairing")).pairCode;
  script.qqIn.push(qqMsg("user-openid", code));
  await reaches(f, "qq", "connected");
};

describe("the chat apps", () => {
  test("take the user's WeChat words to the default channel and answer there", async () => {
    const script = new Script();
    await using f = await farm(script);
    const chat = f.world.channel;
    const status = await weixinConnected(f, script);
    expect(status.user).toBe("o9cq…chat");
    script.weixinIn.push(wx(user, "帮我看看打卡页", "ctx-a"));
    expect(await nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
      app: "weixin",
      to: user,
      text: "【助手】\n收到：帮我看看打卡页",
      reply: "ctx-a",
    });
    expect(await saidIn(f, chat.defaultChannel())).toEqual(["帮我看看打卡页"]);
    const rows = await f.world.db.sql.query(`select d.source, m.meta from session_delivery d
          join channel_message m on m.id = d.message_id where m.body = '帮我看看打卡页'`);
    expect(rows).toEqual([{ source: "connector", meta: `{"ingressSource":"connector"}` }]);
    expect(await statusOf(f, "weixin")()).toMatchObject({
      lastInbound: expect.any(Number),
    });
  });

  test("a malformed durable inbound is settled without blocking later valid messages", async () => {
    const script = new Script();
    await using f = await farm(script);
    const chat = f.world.channel;
    await weixinConnected(f, script);
    await inboundQ.acceptInbound(f.world.db.sql, {
      connector: "weixin",
      ext_id: "poison",
      payload: `{"id":"poison","from":42}`,
      created_at: f.clock.now(),
    });
    script.weixinIn.push(wx(user, "后面的正常消息", "ctx-good"));
    expect(await nth(script, "weixin", 0, "the valid message after a bad row")).toMatchObject({
      text: "【助手】\n收到：后面的正常消息",
    });
    expect(await saidIn(f, chat.defaultChannel())).toEqual(["后面的正常消息"]);
    // Settled once the words are in, which is after the answer went out.
    await waitFor(
      () => inboundQ.pendingInbound(f.world.db.sql, { connector: "weixin" }),
      (rows) => rows.length === 0,
      "both rows settled",
    );
  });

  test("a workbench read withdraws an unsent human handoff", async () => {
    const script = new Script();
    script.restricted = true;
    script.opened = "different-window";
    await using f = await farm(script, testConfig(), { retryFirstMs: 10_000 });
    const chat = f.world.channel;
    await weixinConnected(f, script);
    const channel = chat.defaultChannel();
    await chat.post({ _tag: "Run", from: defaultOrchestrator, channel: channel, text: "已经接下来了", run: "" });
    await waitFor(statusOf(f, "weixin"), (status) => status.pending === 1, "the handoff waiting outside");
    const [message] = await chat.history(channel);
    await chat.markRead(channel, message!.number);
    await waitFor(statusOf(f, "weixin"), (status) => status.pending === 0, "the seen handoff withdrawn");
    const rows = await f.world.db.sql.query(`select state from connector_outbox where message_id = $1`, [message!.id]);
    expect(rows).toEqual([{ state: "dropped" }]);
    expect(script.sent).toEqual([]);
  });

  test("saved connector secrets must be a string map", async () => {
    const config = { ...testConfig(), db: "" };
    const first = new Script();
    {
      await using f = await farm(first, config);
      await weixinConnected(f, first);
      await accountQ.connectAccount(f.world.db.sql, {
        connector: "weixin",
        secrets: `{"token":42}`,
        user_id: user,
        pair_code: null,
        connected_at: f.clock.now(),
      });
    }
    await using f = await farm(new Script(), config);
    const status = await statusOf(f, "weixin")();
    expect(status.error).toContain("存着的登录信息读不出来");
  });

  test("tie WeChat to another channel", async () => {
    const script = new Script();
    await using f = await farm(script);
    const chat = f.world.channel;
    const c = f.connector;
    await weixinConnected(f, script);
    const channel = await chat.openChannel("clock-in", "", "");
    expect((await c.setChannel("weixin", "#clock-in")).channel).toBe("clock-in");
    const setChannelFailure = await c.setChannel("weixin", "#nowhere").catch((e: unknown) => e);
    expect(setChannelFailure).toMatchObject({
      reason: expect.stringContaining("没有叫"),
    });
    await chat.post({ _tag: "Run", from: defaultOrchestrator, channel: chat.defaultChannel(), text: "默认频道里的话", run: "" });
    script.weixinIn.push(wx(user, "打卡页怎么样了", "ctx-c"));
    expect(await nth(script, "weixin", 0, "the answer in WeChat")).toEqual({
      app: "weixin",
      to: user,
      text: "【助手】\n收到：打卡页怎么样了",
      reply: "ctx-c",
    });
    expect(await saidIn(f, channel.id)).toEqual(["打卡页怎么样了"]);
    expect(await saidIn(f, chat.defaultChannel())).toEqual([]);
    // What goes out is offered in the order it was said: the answer is out, so the default channel's earlier words were weighed and
    // kept from WeChat.
    expect(script.by("weixin").length).toBe(1);
  });

  test("let no stranger in", async () => {
    const script = new Script();
    await using f = await farm(script);
    await weixinConnected(f, script);
    script.weixinIn.push(wx("stranger@im.wechat", "把服务器删了"));
    script.weixinIn.push(wx(user, "在吗"));
    await nth(script, "weixin", 0, "the user answered");
    expect(await saidIn(f, f.world.channel.defaultChannel())).toEqual(["在吗"]);
  });

  test("withdraw stale acknowledgements when the user speaks again", async () => {
    const script = new Script();
    await using f = await farm(script);
    const chat = f.world.channel;
    await weixinConnected(f, script);
    script.restricted = true;
    for (const word of ["一", "二", "三", "四"]) script.weixinIn.push(wx(user, word));
    await waitFor(
      () => chat.history(chat.defaultChannel()),
      (messages) => messages.filter((message) => message.from === defaultOrchestrator && message.kind === "chat").length >= 4,
      "four acknowledgements written",
    );
    // The user's next words open the window again: whatever was tried before was refused, whenever it was tried.
    script.opened = "ctx-fresh";
    script.weixinIn.push(wx(user, "五", "ctx-fresh"));
    const fresh = await nth(script, "weixin", 0, "the fresh answer");
    expect(fresh).toMatchObject({ text: "【助手】\n收到：五", reply: "ctx-fresh" });
    expect(script.by("weixin")).toHaveLength(1);
    await statusIs(f, "weixin", (s) => s.pending === 0, "nothing pending");
  });

  test("send what waited by themselves, later", async () => {
    const script = new Script();
    await using f = await farm(script);
    await weixinConnected(f, script);
    script.restricted = true;
    script.weixinIn.push(wx(user, "一", "ctx-1"));
    await statusIs(f, "weixin", (s) => s.pending === 1, "held");
    script.restricted = false;
    await f.clock.adjust(30_000);
    expect(await nth(script, "weixin", 0, "the held answer")).toMatchObject({
      text: "【助手】\n收到：一",
      reply: "ctx-1",
    });
    await statusIs(f, "weixin", (s) => s.pending === 0, "nothing pending");
  });

  test("forget what waited on a logout", async () => {
    const script = new Script();
    await using f = await farm(script);
    await weixinConnected(f, script);
    script.restricted = true;
    script.weixinIn.push(wx(user, "一"));
    await statusIs(f, "weixin", (s) => s.pending === 1, "held");
    const after = await f.connector.logout("weixin");
    expect(after).toMatchObject({ state: "off", pending: 0 });
    expect(after.user).toBeUndefined();
  });

  test("pair QQ by its code, and take only the user's words", async () => {
    const script = new Script();
    await using f = await farm(script);
    const c = f.connector;
    await c.login("qq", { appId: "102", secret: "wrong" });
    const refused = await statusIs(f, "qq", (s) => s.state === "off" && !!s.error, "refused");
    expect(refused.error).toContain("不对");
    await c.login("qq", { appId: "102", secret: "right" });
    const pairing = await reaches(f, "qq", "pairing");
    expect(pairing.pairCode).toMatch(/^\d{6}$/u);
    script.qqIn.push(qqMsg("someone", "你好"));
    script.qqIn.push(qqMsg("user-openid", "配对 " + pairing.pairCode));
    const paired = await reaches(f, "qq", "connected");
    expect(paired.user).toBe("user…enid");
    expect((await nth(script, "qq", 0, "the welcome")).text.startsWith("配对好了")).toBe(true);
    script.qqIn.push(qqMsg("someone", "我也想派活"));
    const last = qqMsg("user-openid", "跑一下测试");
    script.qqIn.push(last);
    expect(await nth(script, "qq", 1, "the answer in QQ")).toEqual({
      app: "qq",
      to: "user-openid",
      text: "【助手】\n收到：跑一下测试",
      reply: last.id,
    });
    expect(await saidIn(f, f.world.channel.defaultChannel())).toEqual(["跑一下测试"]);
  });

  test("a QQ gateway that fails mid-message: what it was handing over arrives, a late handover is refused, and it listens again", async () => {
    const script = new Script();
    let listens = 0;
    let late: ((m: QQMessage) => Promise<void>) | undefined;
    const qq = script.qq;
    // The SDK's handler can outlive its listen: this one keeps got, and fails the gateway once a message is handed over.
    script.qq = {
      ...script.qq,
      listen: (app, got, signal) => {
        listens++;
        return qq.listen(
          app,
          async (m) => {
            if (m.content !== "断开") return got(m);
            late = got;
            await got(qqMsg("user-openid", "断开前的一句"));
            throw failedWith("网关断了");
          },
          signal,
        );
      },
    };
    await using f = await farm(script);
    const chat = f.world.channel;
    await qqPaired(f, script);
    const before = listens;
    script.qqIn.push(qqMsg("user-openid", "断开"));
    // A failed receive is tried again after its backoff on the connector's clock: moved through each time it is asked, as the test cannot see when the backoff starts.
    await waitFor(
      async () => {
        await f.clock.adjust(2_000);
        return listens;
      },
      (n) => n > before,
      "it listens again",
    );
    expect(await saidIn(f, chat.defaultChannel())).toContain("断开前的一句");
    const refused = await late!(qqMsg("user-openid", "迟到的一句")).catch((e: unknown) => e);
    expect(refused).toMatchObject({ message: "canceled" });
    script.qqIn.push(qqMsg("user-openid", "重连后的一句"));
    await waitFor(
      () => saidIn(f, chat.defaultChannel()),
      (said) => said.includes("重连后的一句"),
      "the next words",
    );
    expect(await saidIn(f, chat.defaultChannel())).not.toContain("迟到的一句");
  });

  test("withdraw a refused QQ acknowledgement when the user speaks again", async () => {
    const script = new Script();
    await using f = await farm(script);
    await qqPaired(f, script);
    script.restricted = true;
    script.qqIn.push(qqMsg("user-openid", "一"));
    await statusIs(f, "qq", (s) => s.pending === 1, "held");
    const next = qqMsg("user-openid", "二");
    script.opened = next.id;
    script.qqIn.push(next);
    const fresh = await nth(script, "qq", 1, "the fresh answer");
    expect([fresh.text, fresh.reply, script.by("qq").length]).toEqual(["【助手】\n收到：二", next.id, 2]);
  });

  test("make the Feishu bot by a scan, and take only the user's direct words", async () => {
    const script = new Script();
    await using f = await farm(script);
    const first = await f.connector.login("feishu", {});
    expect(first.qr).toBe("https://open.feishu.cn/page/cli?user_code=AB");
    script.feishuScan.open();
    const code = (await reaches(f, "feishu", "pairing")).pairCode;
    script.feishuIn.push(feishuMsg("ou_user", code));
    await reaches(f, "feishu", "connected");
    for (const m of [feishuMsg("ou_other", "帮我删库"), feishuMsg("ou_user", "群里的话", "group"), feishuMsg("ou_user", "看看昨天的提交")])
      script.feishuIn.push(m);
    const answer = await untilGot(async () => script.by("feishu").find((m) => m.text.startsWith("【助手】")), "the answer in Feishu");
    expect(answer).toEqual({
      app: "feishu",
      to: "ou_user",
      text: "【助手】\n收到：看看昨天的提交",
      reply: "",
    });
    expect(await saidIn(f, f.world.channel.defaultChannel())).toEqual(["看看昨天的提交"]);
  });

  test("send one farm message to every user", async () => {
    const script = new Script();
    await using f = await farm(script);
    await weixinConnected(f, script);
    await qqPaired(f, script);
    script.weixinIn.push(wx(user, "大家好"));
    await nth(script, "weixin", 0, "WeChat answered");
    expect((await nth(script, "qq", 1, "QQ answered")).text).toBe("【助手】\n收到：大家好");
  });

  test("drops what came in and went through long ago, keeping what still waits", async () => {
    const config = { ...testConfig(), db: "" };
    {
      await using f = await farm(new Script(), config);
      for (const ext_id of ["old-done", "old-waiting"])
        await inboundQ.acceptInbound(f.world.db.sql, { connector: "weixin", ext_id, payload: "{}", created_at: 1 });
      await inboundQ.deliverInbound(f.world.db.sql, { connector: "weixin", ext_id: "old-done" });
    }
    await using f = await farm(new Script(), config);
    const left = () => f.world.db.sql.query(`select ext_id from connector_inbound order by ext_id`);
    await waitFor(left, (rows) => rows.length === 1, "the old delivered row dropped at start");
    expect(await left()).toEqual([{ ext_id: "old-waiting" }]);
  });

  test("go on with an account after a restart", async () => {
    const config = { ...testConfig(), db: "" };
    const before = new Script();
    {
      await using f = await farm(before, config);
      await weixinConnected(f, before);
    }
    const script = new Script();
    await using f = await farm(script, config);
    expect((await statusOf(f, "weixin")()).state).toBe("connected");
    script.weixinIn.push(wx(user, "又见面了"));
    await until(async () => {
      const got = await saidIn(f, f.world.channel.defaultChannel());
      return got.length === 1 && got[0] === "又见面了";
    }, "heard after a restart");
  });

  test("route quoted replies to an old thread before and after a restart", async () => {
    const config = { ...testConfig(), db: "" };
    let thread = "";
    // The app's id the old answer went out under: which send was first depends on when the orchestrator's other reply went.
    let answered = "";
    const reply = async (f: ConnectorFarm, script: Script, text: string, sent: number) => {
      const inbound = wx(user, text);
      script.weixinIn.push({
        ...inbound,
        item_list: [...inbound.item_list!, { ref_msg: { svr_id: answered } }],
      });
      await nth(script, "weixin", sent, "the quoted reply answered");
      await waitFor(
        () => saidIn(f, thread),
        (messages) => messages.includes(text),
        "the quoted reply kept in its thread",
      );
      expect(await saidIn(f, f.world.channel.defaultChannel())).not.toContain(text);
      await statusIs(f, "weixin", (s) => s.pending === 0, "the reply saved");
    };
    try {
      const first = new Script();
      {
        await using f = await farm(first, config);
        const chat = f.world.channel;
        await weixinConnected(f, first);
        const parent = (await chat.post({ _tag: "User", text: "这个话题", sendKey: "" })).message;
        const written = await chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "旧的答复", target: `#general:${parent.number}`, anyway: true });
        thread = written.message!.channel;
        await nth(first, "weixin", 0, "the original answer sent");
        await statusIs(f, "weixin", (s) => s.pending === 0, "the external identity saved");
        const sent = await waitFor(
          () => f.world.db.sql.query(`select ext_id from connector_outbox where message_id = $1 and ext_id is not null`, [written.message!.id]),
          (rows) => rows.length > 0,
          "the old answer sent",
        );
        const ext = sent[0]?.["ext_id"];
        answered = typeof ext === "string" ? ext : "";
        for (let i = 0; i < 301; i++) await chat.post({ _tag: "Notice", channel: chat.defaultChannel(), text: `动静 ${i}`, code: "history" });
        await reply(f, first, "继续这个话题", 1);
      }
      const second = new Script();
      await using f = await farm(second, config);
      await reply(f, second, "重启后继续", 0);
    } finally {
      rmSync(config.home, { recursive: true, force: true });
    }
  });

  test("send an old thread's answer only to its linked channel after a restart", async () => {
    const config = { ...testConfig(), db: "" };
    let thread = "";
    try {
      const first = new Script();
      {
        await using f = await farm(first, config);
        const chat = f.world.channel;
        await weixinConnected(f, first);
        const linked = await chat.openChannel("linked", "", "");
        await f.connector.setChannel("weixin", "linked");
        const parent = (await chat.post({ _tag: "User", text: "旧话题", channel: linked.id, sendKey: "" })).message;
        thread = (await chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "旧的答复", target: `#linked:${parent.number}`, anyway: true })).message!
          .channel;
        await nth(first, "weixin", 0, "the old answer sent");
        await statusIs(f, "weixin", (s) => s.pending === 0, "the old answer saved");
        for (let i = 0; i < 100; i++) {
          const other = (await chat.post({ _tag: "User", text: `其他话题 ${i}`, sendKey: "" })).message;
          const fresh = (await chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "其他答复", target: `#general:${other.number}`, anyway: true }))
            .message!.channel;
          await chat.post({ _tag: "Notice", channel: fresh, text: "第一条动静", code: "history" });
          await chat.post({ _tag: "Notice", channel: fresh, text: "第二条动静", code: "history" });
        }
        expect(chat.now()?.channels.some((c) => c.id === thread)).toBe(false);
      }
      const second = new Script();
      await using f = await farm(second, config);
      const chat = f.world.channel;
      expect(chat.now()?.channels.some((c) => c.id === thread)).toBe(false);
      await qqPaired(f, second);
      await chat.post({ _tag: "Run", from: defaultOrchestrator, channel: thread, text: "在旧串里继续答复", run: "" });
      expect((await nth(second, "weixin", 0, "the old thread's new answer sent")).text).toBe("【助手 · 在工单串里】\n在旧串里继续答复");
      expect(second.by("weixin")).toHaveLength(1);
      expect(second.by("qq").map((m) => m.text)).toEqual(["配对好了：以后在这里说的话，就是你在默认频道里说的。"]);
    } finally {
      rmSync(config.home, { recursive: true, force: true });
    }
  });

  test("keeps a quoted message pending when its lookup fails, then delivers it after recovery", async () => {
    const script = new Script();
    await using f = await farm(script);
    const sql = f.world.db.sql;
    const chat = f.world.channel;
    await weixinConnected(f, script);
    await sql.exec("alter table connector_outbox rename to connector_outbox_broken");
    const inbound = wx(user, "引用读取失败");
    script.weixinIn.push({
      ...inbound,
      item_list: [...inbound.item_list!, { ref_msg: { svr_id: "missing" } }],
    });
    await statusIs(f, "weixin", (s) => s.error !== "", "the failed quote lookup");
    expect(script.by("weixin")).toEqual([]);
    expect(await saidIn(f, chat.defaultChannel())).toEqual([]);
    expect(await sql.query(`select ext_id from connector_inbound where not delivered`)).toHaveLength(1);
    await sql.exec("alter table connector_outbox_broken rename to connector_outbox");
    await f.clock.adjust(1_000);
    await nth(script, "weixin", 0, "the quoted message after recovery");
    expect(await saidIn(f, chat.defaultChannel())).toContain("引用读取失败");
  });

  test("backs off instead of spinning when a stale pause cannot be saved", async () => {
    const script = new Script();
    let polls = 0;
    await using f = await farm(script);
    const sql = f.world.db.sql;
    await weixinConnected(f, script);
    await sql.query(`select 1`);
    await refuse(sql, "fail_pause", "before update of paused_until on connector_account", "", "pause failure");
    script.updates = async () => {
      polls++;
      return { ret: -14 };
    };
    script.weixinIn.end();
    await until(() => polls === 1, "the first stale poll");
    await f.clock.adjust(29_999);
    expect(polls).toBe(1);
    await allow(sql, "fail_pause");
    await f.clock.adjust(1);
    await until(() => polls >= 2, "polling after the backoff");
  });

  test("keep the account when retiring what waited fails", async () => {
    const script = new Script();
    await using f = await farm(script);
    const c = f.connector;
    const sql = f.world.db.sql;
    await c.login("qq", { appId: "102", secret: "right" });
    await reaches(f, "qq", "pairing");
    await sql.query(`select 1`);
    await refuse(sql, "fail_outbox", "before update on connector_outbox", "", "disk failure");
    const { message } = await f.world.channel.post({ _tag: "User", text: "pending", sendKey: "" });
    await sql.exec(`insert into connector_outbox (id, connector, message_id, body, created_at) values ('pending-test', 'qq', $1, 'pending', 1)`, [message.id]);
    const status: ConnectorStatus = await c.logout("qq");
    expect(status.state).toBe("pairing");
    expect(status.error).toContain("disk failure");
    const rows = await sql.query(`select secrets from connector_account where connector = 'qq'`);
    expect(rows[0]?.["secrets"]).toContain("102");
    // A new successful login must not replace the account if retiring its outbox fails.
    await c.login("qq", { force: true, appId: "new-app", secret: "right" });
    const again = await untilGot(async () => {
      const s = await statusOf(f, "qq")();
      return s.state === "pairing" && s.error ? s : undefined;
    }, "the failed login");
    expect(again.error).toContain("disk failure");
    const after = await sql.query(`select secrets from connector_account where connector = 'qq'`);
    expect(after[0]?.["secrets"]).not.toContain("new-app");
  });
});
