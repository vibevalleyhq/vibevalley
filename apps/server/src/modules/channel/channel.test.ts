import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { Hub, systemClock, withTimeout } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { channelOf, defaultOf, isBusy } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { messageOf } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { type Core, makeCore } from "#/core/core.ts";
import { makeFrameOf } from "#/gateway/projection/frame.ts";
import { reduce } from "#/gateway/projection/reduce.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { type Db, dbQueries, openDb } from "#/infra/db.ts";
import { keptLog, type Logger } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { makeAgent } from "#/modules/agent/agent.ts";
import builtIn from "#/modules/agent/templates/orchestrator/agent.json" with { type: "json" };
import { type Attachment, makeAttachment } from "#/modules/attachment/attachment.ts";
import { effectsOf } from "#/modules/game/view.ts";
import { wakeBreaker } from "#/modules/mailbox/brakes.ts";
import { type Handed, orchestratorIn } from "#/modules/mailbox/envelope.ts";
import { type Mailbox, makeMailbox } from "#/modules/mailbox/mailbox.ts";
import { restoredSession, sessionState } from "#/modules/session/history.ts";
import { summaryOf } from "#/modules/session/report.ts";
import { sessionOnIssue } from "#/modules/session/roster.ts";
import { DeliveryRefused, newsOf, type Session, type SessionNews } from "#/modules/session/session.ts";
import type { Consumed, LaunchActivity } from "#/modules/session/signals.ts";
import { testConfig, until, waitFor } from "#/testing/layers.ts";
import { topPlace } from "#db/channel.sql.ts";
import { addMember, membersOf, removeMember } from "#db/channel_member.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qsession from "#db/session.sql.ts";

import { type Channel, catchUpMax, type Delivered, makeChannel } from "./channel.ts";

/** Sessions played: a turn takes its input, says it got it and reports. the slow mode is held until release (unless holds is off), the fail mode fails. */
class FakeSessions {
  holds = true;
  stopped = false;
  private held = new Set<() => void>();
  /** Lets every held turn go on. */
  release = () => {
    for (const go of [...this.held]) go();
  };
  inputs = new Map<string, string[]>();
  steers = new Map<string, string[]>();
  last = new Map<string, string>();
  running = new Map<string, string>();
  n = 0;
  core!: Core;
  news = new Hub<SessionNews>();
  consumed = (c: Consumed) => this.news.publish({ _tag: "Consumed", ...c });

  runsOf = (id: string) => [...(this.inputs.get(id) ?? [])];
  steersOf = (id: string) => [...(this.steers.get(id) ?? [])];
  private publish = (a: LaunchActivity) => this.news.publish(a);
  private apply = (...f: Parameters<Core["apply"]>) => this.core.apply(...f);

  deliver = (id: string, text: string, read: () => void = () => {}): Delivered | DeliveryRefused => {
    if (!this.core.session(id)) return new DeliveryRefused("不在地里");
    const launch = this.running.get(id);
    if (launch) {
      this.steers.set(id, [...this.steersOf(id), text]);
      if (!text.includes("必败")) read();
      return { kind: "steered", launch };
    }
    const fresh = `${id}-${++this.n}`;
    this.running.set(id, fresh);
    this.inputs.set(id, [...this.runsOf(id), text]);
    const channel = this.core.session(id)?.channel;
    this.apply({
      type: "sessionPhaseChanged",
      id: sessionId(id),
      ...(channel !== undefined ? { channel } : {}),
      phase: { _tag: "working", since: Date.now(), doing: { action: "thinking", label: "" } },
    });
    void this.run(id, fresh, text, read);
    return { kind: "run", launch: fresh, woke: true };
  };

  private async run(id: string, launch: string, input: string, read: () => void) {
    if (input.includes("慢慢做") && this.holds)
      await new Promise<void>((go) => {
        const done = () => {
          this.held.delete(done);
          go();
        };
        this.held.add(done);
      });
    if (this.stopped) return;
    const runs = this.runsOf(id).length;
    if (!input.includes("必败")) read();
    if (input.includes("必败")) {
      this.running.delete(id);
      this.apply({
        type: "sessionReported",
        questions: [],
        checks: [],
        id: sessionId(id),
        outcome: "failed",
        summary: "provider said no",
        runs,
      });
      this.publish({ _tag: "Ended", id, launch, outcome: "failed", spoke: false });
      return;
    }
    const line = input.split("\n").find((l) => l.startsWith("[target=")) ?? head(input, 20);
    this.last.set(id, "收到了（" + line + "）");
    this.publish({ _tag: "Spoke", id, launch });
    this.running.delete(id);
    this.apply({ type: "sessionReported", questions: [], checks: [], id: sessionId(id), outcome: "completed", summary: "收到了", runs });
    this.publish({ _tag: "Ended", id, launch, outcome: "completed", spoke: true });
  }
}

const DeliveryRow = z.object({ envelope_id: z.string(), reason: z.string(), wakes: z.boolean(), held_by: z.string(), state: z.string() });

/** A test farm reaches no network: a request made by mistake is a failure. */
const offline: typeof fetch = () => Promise.reject(new Error("a test farm reaches no network"));

/** The services of a test, and its helpers. */
interface Farm extends AsyncDisposable {
  readonly core: Core;
  readonly chat: Channel;
  readonly mailbox: Mailbox;
  readonly attachment: Attachment;
  readonly db: Db;
  /** Rows of one statement, its parameters as $1, $2… */
  readonly sql: (text: string, params?: readonly unknown[]) => Promise<readonly Readonly<Record<string, unknown>>[]>;
  /** What was said in a channel, from the farm's start. */
  readonly messagesOf: (channel: string) => T.ChatMessage[];
  readonly channel: (id: string | undefined) => T.Channel | undefined;
  readonly deliveries: (recipient: string) => Promise<z.infer<typeof DeliveryRow>[]>;
  readonly deliveryOf: (recipient: string, message: string) => Promise<z.infer<typeof DeliveryRow> | undefined>;
}

/** The chat over played sessions: the hubs exist before the chat subscribes to them; the played sessions' own facts reach
 * the chat, and the chats start once they are back. */
async function world(x: FakeSessions, config: ServerConfig = testConfig(), log: Logger = keptLog("farm")): Promise<Farm> {
  const c: ServerConfig = { ...config, chat: { noticeBatchMs: 300, retryWakeMs: 100 } };
  const clock = wallTime;
  const db = await openDb(c, log, clock);
  const core = makeCore({ projection: { reduce, effects: effectsOf, frame: makeFrameOf() }, clock });
  x.core = core;
  const all: T.ChatMessage[] = [];
  const events = core.subscribe();
  const heardNow = () => {
    for (const e of events.drain()) if (e.type === "messageChanged") all.push(e.message);
  };
  for (const row of await qsession.activeSessions(db.sql)) core.apply({ type: "sessionChanged", session: restoredSession(row) });
  await qsession.keepSession(db.sql, {
    id: defaultOrchestrator,
    role: "orchestrator",
    agent: defaultOrchestrator,
    name: "助手",
    runtime: "vibevalley",
    brief: "",
    repo: null,
    issue: null,
    channel: null,
    hired_at: 0,
    machine: null,
  });
  const played = {
    isReachable: (id: string) => x.core.session(id) !== undefined,
    sessionOf: (id: string) => x.core.session(id),
    hired: () => x.core.state().sessions.filter((s) => s.role === "worker"),
    deliver: async (id: string, text: string, input: Parameters<Session["deliver"]>[2]) => {
      const out = x.deliver(id, text, () => x.consumed({ session: id, envelopeIds: [...input.envelopeIds] }));
      if (out instanceof DeliveryRefused) throw out;
      return out;
    },
    runOf: () => undefined,
    reportOf: (id: string) => summaryOf(x.last.get(id) ?? ""),
    onIssue: (issue: string) => sessionOnIssue(x.core.state(), issue)?.id,
    news: () => x.news.subscribe(),
  };
  // A test double of the few members the chat and the mailbox use.
  const session = played as unknown as Session;
  const agent = await makeAgent({ config: c, clock, log });
  const mailbox = await makeMailbox({ db, clock, log, config: c, core, agent, session });
  const attachment = await makeAttachment({ config: c, clock, db });
  const chat = await makeChannel({ clock, log, fetch: offline, db, core, agent, attachment, session, mailbox });
  const { changes: moves } = core.transitions();
  const relay = (async () => {
    for await (const { fact, after } of moves) {
      if (fact.type === "sessionLeft") await qsession.endSession(db.sql, { id: fact.id, closed: fact.closed ?? "dismissed", ended_at: fact.at });
      const n = newsOf(fact, after);
      if (n) x.news.publish(n);
    }
  })();
  await chat.start();
  await mailbox.start();
  const deliveries = async (recipient: string) =>
    (
      await db.sql.query(
        "select envelope_id, reason, wakes, coalesce(held_by, '') as held_by, state from mailbox_delivery where session_id = $1 order by envelope_id",
        [recipient],
      )
    ).map((row) => DeliveryRow.parse(row));
  return {
    core,
    chat,
    mailbox,
    attachment,
    db,
    sql: (text, params) => db.sql.query(text, params),
    messagesOf: (channel) => {
      heardNow();
      return all.filter((m) => m.channel === channel);
    },
    channel: (id) => (id ? channelOf(core.state().chat, id) : undefined),
    deliveries,
    deliveryOf: async (recipient, message) => (await deliveries(recipient)).find((d) => d.envelope_id === message),
    [Symbol.asyncDispose]: async () => {
      for (const s of core.state().sessions) await qsession.keepSessionState(db.sql, sessionState(s));
      x.stopped = true;
      x.release();
      moves.close();
      await relay;
      await chat.close();
      await mailbox.close();
      await agent.close();
      events.close();
      core.close();
      await db.close();
    },
  };
}

const keepSession = (f: Farm, session: T.Session) =>
  f.db.sql.exec(
    `insert into session (id, role, agent, name, runtime, brief, repo, issue, channel, hired_at, phase, refining, runs)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (id) do nothing`,
    [
      session.id,
      session.role,
      session.agent,
      session.name,
      session.runtime,
      session.brief,
      session.repo ?? null,
      session.issue ?? null,
      session.channel ?? null,
      session.hiredAt,
      jsonText(session.phase),
      session.refining,
      session.runs,
    ],
  );

const hire = async (f: Farm, _x: FakeSessions, id: string, brief: string, repo: string, channel?: string, issue?: string) => {
  const session: T.Session = {
    id: sessionId(id),
    role: "worker",
    name: "帮工" + id,
    agent: "lab",
    runtime: "pi",
    brief,
    repo,
    hiredAt: Date.now(),
    runs: 0,
    phase: { _tag: "resting" },
    ...(channel ? { channel } : {}),
    ...(issue ? { issue: issueId(issue) } : {}),
    refining: false,
  };
  await keepSession(f, session);
  f.core.apply({ type: "sessionChanged", session });
  const thread = await waitFor(
    async () => f.channel(await f.chat.threadOfSession(id)),
    (c) => c !== undefined,
    "an issue thread",
  );
  return thread!;
};

/** Hired, and its first turn reported in its thread. */
const hireAndRun = async (f: Farm, x: FakeSessions, id: string, brief: string, repo: string, channel?: string) => {
  const thread = await hire(f, x, id, brief, repo, channel);
  expect(x.deliver(id, brief)).toMatchObject({ kind: "run" });
  await until(() => f.messagesOf(thread.id).some((m) => m.kind === "report" && m.from === id), "its first report");
  return thread;
};

const news = (f: Farm) => {
  const heard: Handed[] = [];
  const sub = f.mailbox.news();
  const pull = () => {
    for (const n of sub.drain()) if (n._tag === "Handed") heard.push(n);
  };
  return {
    of: async (message: string) => {
      await until(() => {
        pull();
        return heard.some((n) => n.messages.some((m) => m.id === message));
      }, `the orchestrator hearing of ${message}`);
      return heard.find((n) => n.messages.some((m) => m.id === message))!;
    },
  };
};

const run = async (body: (f: Farm, x: FakeSessions) => Promise<void>, config?: ServerConfig, log?: Logger) => {
  const x = new FakeSessions();
  await using f = await world(x, config, log);
  await body(f, x);
};

/** What the call failed with. */
const failure = async (p: Promise<unknown>): Promise<Error & { readonly bizCode?: unknown }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("it did not fail");
};

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "Success",
    () => "Failure",
  );

/** The first n events of a stream, then it is let go of. */
const take = async <A>(source: AsyncIterable<A>, n: number): Promise<A[]> => {
  const got: A[] = [];
  if (n <= 0) return got;
  for await (const a of source) {
    got.push(a);
    if (got.length >= n) break;
  }
  return got;
};

const drain = async (source: AsyncIterable<unknown>) => {
  for await (const _ of source);
};

/** A trigger named name refusing the write on (before insert on t), when when holds (a condition on NEW); the write fails with its name. */
const trigger = async (db: Db, name: string, on: string, when = "") => {
  await db.sql.exec(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception '${name}'; end $$`);
  await db.sql.exec(`create trigger ${name} ${on} for each row ${when ? `when (${when})` : ""} execute function ${name}()`);
};
/** The write trigger stopped goes through again. */
const drop = async (db: Db, name: string, table: string) => {
  await db.sql.exec(`drop trigger ${name} on ${table}`);
  await db.sql.exec(`drop function ${name}()`);
};

describe("the chat", () => {
  test("regression: freshness pages advance the read cursor without skipping older messages", () =>
    run(async (f, x) => {
      await hireAndRun(f, x, "w-page", "work", "paging-repo");
      const channel = await f.chat.openChannel("paging", "", "");
      for (const text of ["first", "second", "third", "fourth", "fifth"]) await f.chat.post({ _tag: "User", text: text, channel: channel.id, sendKey: "" });
      const options = { target: "#paging", confirm: true };
      const first = await f.chat.post({ _tag: "Agent", from: "w-page", text: "reply", ...options });
      expect(first.shown?.map((message) => message.text)).toEqual(["first", "second", "third"]);
      expect(first.more).toBe(2);
      const rows = await f.sql(`select read_number from channel_read_cursor where participant_id = 'w-page' and channel_id = $1`, [channel.id]);
      expect(rows).toEqual([{ read_number: 3 }]);
      const second = await f.chat.post({ _tag: "Agent", from: "w-page", text: "reply", ...options });
      expect(second.shown?.map((message) => message.text)).toEqual(["fourth", "fifth"]);
      expect(second.more).toBe(0);
      expect((await f.chat.post({ _tag: "Agent", from: "w-page", text: "reply", ...options })).kind).toBe("sent");
    }));
  test("a line said to an orchestrator reaches it alone, even where no one is in; said to a helper it is refused", () =>
    run(async (f) => {
      const quiet = (await f.chat.openChannel("quiet", "", "")).id;
      await f.chat.updateChannel(quiet, { members: [] });
      // Routing is done when say returns: the deliveries are written with the message.
      const unheard = (await f.chat.post({ _tag: "User", text: "有人吗", channel: quiet, sendKey: "" })).message;
      const asked = (await f.chat.post({ _tag: "User", text: "/imagegen 一只在麦田里打盹的橘猫", channel: quiet, sendKey: "", to: defaultOrchestrator }))
        .message;
      const toNoOne = await f.deliveryOf(defaultOrchestrator, unheard.id);
      const toIt = await f.deliveryOf(defaultOrchestrator, asked.id);
      expect([toNoOne, toIt?.reason]).toEqual([undefined, "addressed"]);
      const refused = await failure(f.chat.post({ _tag: "User", text: "画一张", channel: quiet, sendKey: "", to: "lab" }));
      expect(refused).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
    }));
  test("regression: publishing to the orchestrator does not acknowledge model consumption", () =>
    run(async (f, x) => {
      const heard = news(f);
      const message = (await f.chat.post({ _tag: "User", text: "等实际入模", sendKey: "" })).message;
      await heard.of(message.id);
      expect((await f.deliveryOf(defaultOrchestrator, message.id))?.state).toBe("handed");
      expect((await f.chat.history(f.chat.defaultChannel())).find((item) => item.id === message.id)?.reactions).toEqual([]);
      await f.chat.read(defaultOrchestrator, { target: "#general" });
      expect((await f.deliveryOf(defaultOrchestrator, message.id))?.state).toBe("handed");
      x.consumed({ session: defaultOrchestrator, envelopeIds: [message.id] });
      await until(async () => (await f.deliveryOf(defaultOrchestrator, message.id))?.state === "consumed", "the model consumption receipt");
      // The 👀 follows the consumption on the delivery changes' own fiber.
      const reacted = await waitFor(
        async () => (await f.chat.history(f.chat.defaultChannel())).find((item) => item.id === message.id)?.reactions ?? [],
        (reactions) => reactions.length > 0,
        "the 👀 on the consumed message",
      );
      expect(reacted).toEqual([{ emoji: "👀", by: [defaultOrchestrator] }]);
    }));
  // A budget, at what it takes today: one line from the user in the general channel, written, delivered and told. A change that asks more fails here.
  test("one line from the user reads and writes the database a bounded number of times", () =>
    run(async (f) => {
      await f.chat.post({ _tag: "User", text: "先暖一下", sendKey: "" });
      const before = dbQueries.count();
      await f.chat.post({ _tag: "User", text: "今天进度怎么样", sendKey: "" });
      const used = dbQueries.count() - before;
      expect(used).toBeGreaterThan(0);
      expect(used, `${used} queries`).toBeLessThanOrEqual(17);
    }));

  test("a dispatched issue opens a thread under its dispatch", () =>
    run(async (f, x) => {
      const thread = await hireAndRun(f, x, "w1", "写 hello", "chat-a");
      const general = defaultOf(f.core.state().chat)!;
      expect(general.id).toBe(f.chat.defaultChannel());
      const dispatch = f.messagesOf(general.id).find((m) => m.kind === "dispatch" && m.session === "w1")!;
      expect(thread.root).toBe(dispatch.id);
      expect(dispatch.text).toContain("派 @w1（帮工w1）去 chat-a：写 hello");
      const report = f.messagesOf(thread.id).findLast((m) => m.kind === "report")!;
      expect([report.from, report.actor.kind, report.actor.kind === "agent" ? report.actor.role : undefined, report.outcome]).toEqual([
        "w1",
        "agent",
        "worker",
        "completed",
      ]);
      expect(report.text).toContain("收到了");
      expect(report.text).not.toContain("结论");
      const threadOfSession2 = await f.chat.threadOfSession("w1");
      expect(threadOfSession2).toBe(thread.id);
    }));

  test("a session sent for no issue has a talk thread", () =>
    run(async (f, x) => {
      const talk = await hireAndRun(f, x, "w1", "写 hello", "chat-t");
      expect([talk.subjectKind, talk.subjectId]).toEqual(["talk", "w1"]);
      const dispatched = await hire(f, x, "w2", "写 world", "chat-t", undefined, "i1");
      expect([dispatched.subjectKind, dispatched.subjectId, dispatched.id !== talk.id]).toEqual(["issue", "i1", true]);
      await f.chat.post({ _tag: "User", text: "把输出改成中文", channel: talk.id, sendKey: "" });
      await until(() => x.runsOf("w1").length >= 2, "a second turn");
    }));

  test("the user's words in an issue thread wake its session", () =>
    run(async (f, x) => {
      const thread = await hireAndRun(f, x, "w2", "写 hello", "chat-b");
      const { message: said } = await f.chat.post({ _tag: "User", text: "把输出改成中文", channel: thread.id, sendKey: "" });
      await until(() => x.runsOf("w2").length >= 2, "a second turn");
      expect(x.runsOf("w2")[1]).toContain(`[target=#general:${thread.rootNumber} msg=${said.number} from=用户] 把输出改成中文`);
      await until(async () => (await f.deliveryOf("w2", said.id))?.state === "consumed", "consumed");
      await until(() => f.messagesOf(thread.id).filter((m) => m.kind === "report").length >= 2, "its reply in the thread");
    }));

  test("the general channel reaches the orchestrator", () =>
    run(async (f, x) => {
      await hireAndRun(f, x, "w3", "写 hello", "chat-c");
      const heard = news(f);
      const before = x.runsOf("w3").length;
      const { message: said } = await f.chat.post({ _tag: "User", text: "今天进度怎么样", sendKey: "" });
      const n = await heard.of(said.id);
      expect([n.messages.length, n.messages[0]!.text, n.target, n.channel]).toEqual([1, "今天进度怎么样", "#general", f.chat.defaultChannel()]);
      // Who is handed what is settled before say returns: a session not woken by now is not woken by it.
      expect(x.runsOf("w3")).toHaveLength(before);
      const deliveryOf2 = await f.deliveryOf("w3", said.id);
      expect(deliveryOf2).toMatchObject({ reason: "channel", wakes: false });
      const deliveryOf3 = await f.deliveryOf(defaultOrchestrator, said.id);
      expect(deliveryOf3).toMatchObject({ state: "handed" });
    }));

  test("the user talks with the orchestrator alone in their direct channel", async () => {
    const config = { ...testConfig(), db: "" };
    const directs = (f: Farm) => (f.core.state().chat?.channels ?? []).filter((c) => c.type === "direct");
    await run(async (f, x) => {
      await hireAndRun(f, x, "w3", "写 hello", "chat-d");
      const [direct, ...more] = directs(f);
      expect([direct?.peer, direct?.title, more.length]).toEqual([defaultOrchestrator, builtIn.name, 0]);
      const heard = news(f);
      const before = x.runsOf("w3").length;
      const { message: said } = await f.chat.post({ _tag: "User", text: "@w3 你先别动，我们单独说", channel: direct!.id, sendKey: "" });
      const n = await heard.of(said.id);
      expect([n.channel, n.type, n.target]).toEqual([direct!.id, "direct", "@user"]);
      const deliveryOf2 = await f.deliveryOf(defaultOrchestrator, said.id);
      expect(deliveryOf2).toMatchObject({ reason: "direct", wakes: true });
      const deliveryOf3 = await f.deliveryOf("w3", said.id);
      expect(deliveryOf3).toBeUndefined();
      expect(x.runsOf("w3")).toHaveLength(before);
      expect(f.messagesOf(direct!.id).at(-1)?.mentions).toEqual([]);
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: direct!.id, text: "好，说吧", run: "" });
      await until(() => (f.channel(direct!.id)?.unread ?? 0) === 1, "the answer unread");
      expect((await f.chat.read(defaultOrchestrator, { target: "@用户" })).messages.map((m) => m.text)).toEqual(["@w3 你先别动，我们单独说", "好，说吧"]);
      const addressOf2 = await f.chat.addressOf(direct!.id);
      expect(addressOf2).toEqual({ direct: true, target: "@user" });
      expect((await f.chat.topOf(direct!.id)).id).toBe(f.chat.defaultChannel());
      const chatFailure = await failure(f.chat.read("w3", { target: "@user" }));
      expect(chatFailure).toMatchObject({ message: expect.stringContaining("没有私聊") });
      expect((await f.chat.channels()).map((c) => c.name)).toEqual(["general"]);
      const defaultFailure = await failure(f.chat.makeDefault(direct!.id));
      expect(defaultFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
    }, config);
    await run(async (g) => {
      expect(directs(g)).toHaveLength(1);
    }, config);
  });

  test("a channel is renamed, grouped, placed, archived, quieted, and deleted once nothing points at it", () =>
    run(async (f) => {
      const a = (await f.chat.openChannel("aa", "", "")).id;
      const b = (await f.chat.openChannel("bb", "", "")).id;
      await f.chat.updateChannel(a, { name: "前端", category: "仓库" });
      expect(f.channel(a)).toMatchObject({ name: "前端", category: "仓库" });
      const channelUpdatedFailure = await failure(f.chat.updateChannel(b, { name: "前端" }));
      expect(channelUpdatedFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
      await f.chat.updateChannel(b, { before: a });
      expect((await f.chat.channels()).map((c) => c.name)).toEqual(["general", "bb", "前端"]);

      const said = (await f.chat.post({ _tag: "User", text: "一句话", channel: a, sendKey: "" })).message;
      const thread = await f.chat.threadUnder(said.id);
      expect(f.channel(thread)?.title).toBe("一句话");
      await f.chat.updateChannel(thread, { name: "细说" });
      expect(f.channel(thread)?.title).toBe("细说");
      const channelUpdatedFailure2 = await failure(f.chat.updateChannel(thread, { category: "x" }));
      expect(channelUpdatedFailure2).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });

      await f.chat.archive(a, true);
      const archived = f.channel(a)?.archived;
      expect(archived).toBeDefined();
      // Set as it already is: nothing changes, not even when it was archived.
      await f.chat.archive(a, true);
      expect(f.channel(a)?.archived).toBe(archived);
      await f.chat.archive(a, false);
      expect(f.channel(a)?.archived).toBeUndefined();
      await f.chat.archive(a, false);
      expect(f.channel(a)?.archived).toBeUndefined();
      const archiveFailure = await failure(f.chat.archive(f.chat.defaultChannel(), true));
      expect(archiveFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });

      await f.chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "随便说说", target: "#前端", anyway: true, confirm: true });
      await f.chat.setNotify(a, "mentions");
      expect(f.channel(a)?.unread).toBeUndefined();
      await f.chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "@用户 看一下", target: "#前端", anyway: true, confirm: true });
      expect(f.channel(a)?.unread).toBe(1);
      expect(f.chat.notifyOf(thread)).toBe("mentions");
      await f.chat.setNotify(a, "none");
      expect([f.channel(a)?.unread, f.core.state().chat?.userMentions.length ?? 0, f.chat.notifyOf(thread)]).toEqual([undefined, 0, "none"]);

      await f.chat.setNotify(a, "all");
      await f.chat.markRead(a, 99);
      await f.chat.markUnread(a, said.number);
      expect([f.channel(a)?.read, f.channel(a)?.unread]).toEqual([said.number - 1, 2]);

      // A cron of the cron module's, as its table has it.
      await f.sql(`insert into cron (id, name, body, channel_id, spec, tz, created_at) values ('r1', '看看', '看一眼', $1, '{}', 'UTC', 0)`, [a]);
      const channelRemovedFailure = await failure(f.chat.removeChannel(a));
      expect(channelRemovedFailure).toMatchObject({ message: expect.stringContaining("定时任务") });
      const channelRemovedFailure2 = await failure(f.chat.removeChannel(f.chat.defaultChannel()));
      expect(channelRemovedFailure2).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
      expect((await f.chat.previewRemoveChannel(b)).does[0]).toContain("#bb");
      await f.chat.removeChannel(b);
      expect([f.channel(b), (await f.chat.channels()).map((c) => c.name)]).toEqual([undefined, ["general", "前端"]]);
    }));

  test("regression: deleting a channel forgets the last read of its child threads", () =>
    run(async (f) => {
      const channel = await f.chat.openChannel("temporary", "", "");
      const root = (await f.chat.post({ _tag: "User", text: "a thread", channel: channel.id, sendKey: "" })).message;
      await f.chat.threadUnder(root.id);
      await f.chat.read(defaultOrchestrator, { target: `#temporary:${root.number}` });
      await f.chat.removeChannel(channel.id);
      expect((await f.chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "back here", target: "#general", anyway: true })).kind).toBe("sent");
    }));

  test("a search reads its filters, and an edit can take a message's files off", () =>
    run(async (f) => {
      const general = f.chat.defaultChannel();
      const file = await f.attachment.attach({ name: "图.png", type: "image/png", data: Buffer.from("x").toString("base64") });
      const pictured = (await f.chat.post({ _tag: "User", text: "看图", sendKey: "", attachments: [file.id] })).message;
      await f.chat.post({ _tag: "User", text: "一个链接 https://example.com/page", sendKey: "" });
      await f.chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "我看了图", anyway: true, confirm: true });
      const text = async (q: string) => (await f.chat.search(q)).map((h) => h.message.text);
      const text2 = await text("has:image");
      expect(text2).toEqual(["看图"]);
      const text3 = await text("has:link");
      expect(text3).toEqual(["一个链接 https://example.com/page"]);
      const text4 = await text("图 from:助手");
      expect(text4).toEqual(["我看了图"]);
      const text5 = await text("from:用户 in:#general 图");
      expect(text5).toEqual(["看图"]);
      const text6 = await text("图 before:2000-01-01");
      expect(text6).toEqual([]);
      const chatsFailure = await failure(f.chat.search("in:#nowhere"));
      expect(chatsFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelNotFound });

      const bare = await f.chat.edit(pictured.id, "看图（图去掉了）", []);
      expect([bare.attachments, bare.text]).toEqual([[], "看图（图去掉了）"]);
      expect((await f.chat.history(general)).find((m) => m.id === pictured.id)?.attachments).toEqual([]);
    }));

  test("channels", () =>
    run(async (f, x) => {
      const channel = await f.chat.openChannel("#clock-in", "打卡页", "chat-ch");
      expect(channel).toMatchObject({ name: "clock-in", repo: "chat-ch", description: "打卡页" });
      const channelFailure = await failure(f.chat.openChannel("clock-in", "", ""));
      expect(channelFailure).toMatchObject({ message: expect.stringContaining("已经有") });
      expect((await f.chat.channels()).map((c) => c.name)).toEqual(["general", "clock-in"]);
      const thread = await hireAndRun(f, x, "w4", "写 hello", "chat-ch", channel.id);
      expect(thread.parent).toBe(channel.id);
      const dispatch = f.messagesOf(channel.id).find((m) => m.kind === "dispatch" && m.session === "w4");
      expect(thread.root).toBe(dispatch?.id);
      await hireAndRun(f, x, "w5", "写 hello", "chat-sq");
      const heard = news(f);
      const { message: said } = await f.chat.post({ _tag: "User", text: "打卡页今天能好吗", channel: channel.id, sendKey: "" });
      const n = await heard.of(said.id);
      expect([n.channel, n.target]).toEqual([channel.id, "#clock-in"]);
      const deliveryOf2 = await f.deliveryOf("w4", said.id);
      expect(deliveryOf2).toMatchObject({ reason: "channel" });
      const deliveryOf3 = await f.deliveryOf("w5", said.id);
      expect(deliveryOf3).toBeUndefined();
      expect((await f.chat.read("w4", { target: "#clock-in" })).target).toBe("#clock-in");
      expect((await f.chat.post({ _tag: "Agent", from: "w4", text: "今天能好", target: "#clock-in", anyway: true, confirm: true })).kind).toBe("sent");
      const chatFailure = await failure(f.chat.read("w4", { target: "#nowhere" }));
      expect(chatFailure).toMatchObject({
        name: "ApiError",
        bizCode: BizCode.ChannelNotFound,
        message: expect.stringContaining("没有叫 #nowhere 的频道"),
      });
      expect((await f.chat.topOf(thread.id)).name).toBe("clock-in");
      await f.chat.updateChannel(channel.id, { repo: "" });
      const channelByName2 = await f.chat.channelByName("clock-in");
      expect(channelByName2).toMatchObject({ repo: "", description: "打卡页" });
      expect(channelOf(f.core.state().chat, channel.id)?.repo).toBeUndefined();
      const general = f.chat.defaultChannel();
      await f.chat.makeDefault(channel.id);
      expect([f.chat.defaultChannel(), defaultOf(f.core.state().chat)?.id, channelOf(f.core.state().chat, general)?.default]).toEqual([
        channel.id,
        channel.id,
        false,
      ]);
      expect((await f.chat.channels()).map((c) => c.name)).toEqual(["clock-in", "general"]);
      expect((await f.chat.post({ _tag: "User", text: "没写频道", sendKey: "" })).message.channel).toBe(channel.id);
    }));

  test("regression: a busy session gets the full input burst in one steer", () =>
    run(async (f, x) => {
      const thread = await hire(f, x, "w6", "慢慢做一个大活", "chat-d");
      x.deliver("w6", "慢慢做一个大活");
      expect(isBusy(f.core.session("w6")!)).toBe(true);
      await f.chat.post({ _tag: "User", text: "补充：顺便写测试", channel: thread.id, sendKey: "" });
      await f.chat.post({ _tag: "User", text: "还有：写 README", channel: thread.id, sendKey: "" });
      await until(() => x.steersOf("w6").some((s) => s.includes("顺便写测试") && s.includes("写 README")), "the full input burst");
      expect(x.steersOf("w6")).toHaveLength(1);
      await until(async () => (await f.deliveries("w6")).every((row) => row.state === "consumed"), "the steered inputs consumed");
      x.release();
      expect(x.runsOf("w6")).toHaveLength(1);
    }));

  test("regression: speaking before turn end does not consume an unacknowledged input", () =>
    run(async (f, x) => {
      const thread = await hire(f, x, "w6", "work", "unconsumed");
      const acknowledge = x.consumed;
      x.consumed = () => {};
      const message = (await f.chat.post({ _tag: "User", text: "followup without a model receipt", channel: thread.id, sendKey: "" })).message;
      await until(
        async () => x.runsOf("w6").length > 0 && (await f.deliveryOf("w6", message.id))?.state === "pending",
        "the spoken but unconsumed input returned",
      );
      x.consumed = acknowledge;
      await until(async () => (await f.deliveryOf("w6", message.id))?.state === "consumed", "the retried input consumed");
      expect(x.runsOf("w6").length).toBeGreaterThan(1);
      expect(x.runsOf("w6").at(-1)).toContain("followup without a model receipt");
    }));

  test("a line told to a session with no thread is a recorded trigger delivered to it alone", () =>
    run(async (f) => {
      // Only workers get a thread: a second orchestrator session is present and has none.
      const session: T.Session = {
        id: sessionId("o2"),
        role: "orchestrator",
        name: "另一个助手",
        agent: "lab",
        runtime: "pi",
        brief: "",
        repo: "",
        hiredAt: Date.now(),
        runs: 0,
        phase: { _tag: "resting" },
        refining: false,
      };
      await keepSession(f, session);
      f.core.apply({ type: "sessionChanged", session });
      const thread = await f.chat.threadOfSession("o2");
      expect(thread).toBeUndefined();
      await f.chat.post({ _tag: "Tell", from: userId, session: "o2", text: "直接说给它", sendKey: "" });
      const recorded = (await f.sql(`select id from mailbox_trigger where trigger_json like $1`, ["%直接说给它%"])).map((r) => ({ id: String(r["id"]) }));
      expect(recorded).toHaveLength(1);
      await until(async () => (await f.deliveryOf("o2", recorded[0]!.id)) !== undefined, "its delivery");
      const delivered = await f.deliveryOf("o2", recorded[0]!.id);
      expect(delivered).toMatchObject({ reason: "addressed", held_by: "" });
    }));

  test("helpers calling each other stop at the hop limit", () =>
    run(async (f, x) => {
      const thread = await hireAndRun(f, x, "w7", "写 hello", "chat-e");
      // The orchestrator is never cooled down, so only the hop limit holds.
      for (let i = 1; i <= 5; i++) expect((await f.chat.post({ _tag: "Agent", from: "w7", text: `@助手 第 ${i} 次问`, anyway: true })).kind).toBe("sent");
      const held = (await f.deliveries(defaultOrchestrator)).filter((d) => d.reason === "mention").map((d) => d.held_by);
      expect(held).toEqual(["", "", "", "", "hop_limit"]);
      const notices = f.messagesOf(thread.id).filter((m) => m.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("来回 4 次");
    }));

  test("a session that fails every wake is not woken again until the user says so", () =>
    run(async (f, x) => {
      const a = await hireAndRun(f, x, "w8", "写 hello", "chat-f");
      await hireAndRun(f, x, "w9", "写 world", "chat-g");
      await f.chat.post({ _tag: "User", text: "@w8 这次必败", sendKey: "" });
      await until(() => f.messagesOf(a.id).some((m) => m.kind === "notice" && m.text.includes("一叫醒就失败")), "the breaker notice");
      expect(x.runsOf("w8")).toHaveLength(1 + wakeBreaker);
      for (const d of await f.deliveries("w8")) if (d.reason === "mention") expect(d.state).toBe("pending");
      expect((await f.chat.post({ _tag: "Agent", from: "w9", text: "@w8 你那边怎么样", anyway: true })).kind).toBe("sent");
      expect((await f.deliveries("w8")).at(-1)?.held_by).toBe("wake_breaker");
      await f.chat.post({ _tag: "User", text: "@w8 再试一次", sendKey: "" });
      await until(() => x.runsOf("w8").at(-1)!.includes("再试一次"), "woken by the user");
    }));

  test("speaking: retries, what it has not seen, confirming a channel, absent names and threads", () =>
    run(async (f, x) => {
      const thread = await hireAndRun(f, x, "w10", "写 hello", "chat-h");
      const first = await f.chat.post({ _tag: "Agent", from: "w10", text: "我先看看代码" });
      const again = await f.chat.post({ _tag: "Agent", from: "w10", text: "我先看看代码" });
      expect([first.kind, again.kind, again.message?.id]).toEqual(["sent", "sent", first.message?.id]);
      const { message: words } = await f.chat.post({ _tag: "User", text: "先别动 main", channel: thread.id, sendKey: "" });
      const held = await f.chat.post({ _tag: "Agent", from: "w10", text: "我改好了" });
      expect([held.kind, held.shown?.map((m) => m.id)]).toEqual(["held", [words.id]]);
      expect((await f.chat.post({ _tag: "Agent", from: "w10", text: "我改好了" })).kind).toBe("sent");
      await f.chat.read("w10");
      const asked = await f.chat.post({ _tag: "Agent", from: "w10", text: "大家好", target: "#general" });
      expect([asked.kind, asked.lastRead]).toEqual(["confirm", `#general:${thread.rootNumber}`]);
      expect((await f.chat.post({ _tag: "Agent", from: "w10", text: "大家好", target: "#general", confirm: true, anyway: true })).kind).toBe("sent");
      const absent = await f.chat.post({ _tag: "Agent", from: "w10", text: "@w99 你在吗", anyway: true });
      expect([absent.kind, absent.absent]).toEqual(["sent", ["w99"]]);
      const spokenFailure = await failure(f.chat.post({ _tag: "Agent", from: "w10", text: "hi", target: "#general:999999" }));
      expect(spokenFailure).toMatchObject({
        message: expect.stringContaining("没有 999999 这条消息"),
      });
      const { message: sq } = await f.chat.post({ _tag: "User", text: "大家早", channel: f.chat.defaultChannel(), sendKey: "" });
      const talk = await f.chat.post({ _tag: "Agent", from: "w10", text: "早", target: `#general:${sq.number}`, anyway: true });
      expect([talk.kind, talk.target]).toEqual(["sent", `#general:${sq.number}`]);
      const under = f.core.state().chat?.channels.find((c) => c.root === sq.id);
      expect(under?.subjectKind).toBe("talk");
    }));

  test("the orchestrator's words are written once, whole, and delivered", () =>
    run(async (f, x) => {
      await hireAndRun(f, x, "w11", "写 hello", "chat-k");
      const general = f.chat.defaultChannel();
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: "  ", run: "" });
      const ours = () => f.messagesOf(general).filter((m) => m.from === defaultOrchestrator && m.kind === "chat");
      expect(ours()).toEqual([]);
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: "好的，我叫 @w11 去看看", run: "" });
      expect(ours().map((m) => [m.text, m.mentions])).toEqual([["好的，我叫 @w11 去看看", ["w11"]]]);
      await until(() => x.runsOf("w11").length >= 2 && x.runsOf("w11")[1]!.includes("我叫 @w11 去看看"), "w11 woken");
      await f.chat.post({ _tag: "Notice", channel: general, text: "定时任务到了", code: "cron" });
      await until(() => f.messagesOf(general).some((m) => m.kind === "notice" && m.text === "定时任务到了"), "the notice");
      const last = f.messagesOf(general).at(-1)!;
      expect([last.kind, last.from]).toEqual(["notice", "system"]);
      expect((await f.deliveries("w11")).at(-1)?.envelope_id).not.toBe(last.id);
    }));

  test("history, pages and marking read", () =>
    run(async (f) => {
      const general = f.chat.defaultChannel();
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) seqs.push((await f.chat.post({ _tag: "User", text: `第 ${i} 句`, channel: general, sendKey: "" })).message.number);
      const got = await f.chat.history(general, seqs[4], 2);
      expect(got.map((m) => m.number)).toEqual([seqs[2], seqs[3]]);
      const page = await f.chat.read("user", { target: "#general", before: seqs[4]!, limit: 2 });
      expect([page.messages.map((m) => m.number), page.older]).toEqual([[seqs[2], seqs[3]], true]);
      const older = await f.chat.read("user", { target: "#general", before: page.messages[0]!.number, limit: 2 });
      expect([older.messages.map((m) => m.number), older.older]).toEqual([[seqs[0], seqs[1]], false]);
      await f.chat.markRead(general, seqs[1]!);
      expect((await failure(f.chat.markRead("nope", 1))).bizCode).toBe(BizCode.ChannelNotFound);
      expect(defaultOf(f.core.state().chat)?.read).toBe(seqs[4]);
      expect((await failure(f.chat.post({ _tag: "User", text: "  ", sendKey: "" }))).bizCode).toBe(BizCode.ChannelRefused);
      const orchestratorDigest2 = await f.mailbox.orchestratorDigest(defaultOrchestrator);
      expect(orchestratorDigest2).toEqual([]);
    }));

  test("the inbox and the orchestrator's digest", () =>
    run(async (f, x) => {
      const thread = await hireAndRun(f, x, "w12", "写 hello", "chat-l");
      const digest = await f.mailbox.orchestratorDigest(defaultOrchestrator);
      expect(digest.map((d) => [d.from, d.target])).toEqual([["w12", `#general:${thread.rootNumber}`]]);
      const orchestratorDigest2 = await f.mailbox.orchestratorDigest(defaultOrchestrator);
      expect(orchestratorDigest2).toHaveLength(1);
      // Taken as input by the orchestrator's run, as its execution says once it took it.
      x.consumed({ session: defaultOrchestrator, envelopeIds: [digest[0]!.id] });
      await waitFor(
        () => f.mailbox.orchestratorDigest(defaultOrchestrator),
        (rows) => rows.length === 0,
        "the digest input consumed",
      );
      await f.chat.post({ _tag: "User", text: "大家看一下", channel: f.chat.defaultChannel(), sendKey: "" });
      const unread = await f.chat.unread("w12");
      expect(unread).toEqual([{ channel: "#general", unread: 2, mentionsYou: true, latest: "用户" }]);
      await f.chat.read("w12", { target: "#general" });
      const unread2 = await f.chat.unread("w12");
      expect(unread2).toEqual([]);
    }));

  test("a session that leaves has what was for it dropped", () =>
    run(async (f, x) => {
      await hireAndRun(f, x, "w13", "写 hello", "chat-m");
      await until(() => !isBusy(f.core.session("w13")!), "resting");
      await f.chat.post({ _tag: "User", text: "随便说说", channel: f.chat.defaultChannel(), sendKey: "" });
      f.core.apply({ type: "sessionLeft", id: sessionId("w13") });
      await until(async () => (await f.deliveries("w13")).at(-1)?.state === "dropped", "dropped");
      const left = await f.sql(`select left_at from channel_participant where id = 'w13'`);
      expect(left[0]?.left_at).not.toBeNull();
    }));

  test("after a restart what was handed is given again", async () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    let said: T.ChatMessage;
    await run(async (f, x) => {
      thread = await hireAndRun(f, x, "w14", "写 hello", "chat-i");
      said = (await f.chat.post({ _tag: "User", text: "慢慢做：再加一个文件", channel: thread.id, sendKey: "" })).message;
      await until(async () => (await f.deliveryOf("w14", said.id))?.state === "handed", "handed");
    }, config);
    await run(async (g, y) => {
      y.holds = false;
      expect(g.core.session("w14")).toBeDefined();
      g.core.apply({
        type: "sessionReported",
        questions: [],
        checks: [],
        id: sessionId("w14"),
        outcome: "interrupted",
        summary: "重启了",
        runs: 1,
      });
      await until(async () => (await g.deliveryOf("w14", said.id))?.state === "consumed", "seen after the restart");
      expect(y.runsOf("w14").at(-1)).toContain("再加一个文件");
      const threadOfSession2 = await g.chat.threadOfSession("w14");
      expect(threadOfSession2).toBe(thread.id);
      // The new farm has heard nothing yet: what was said before is in the room's history.
      expect((await g.chat.history(thread.id)).some((m) => m.id === said.id)).toBe(true);
    }, config);
  });

  test("regression: a committed message without a route receipt is routed after restart", async () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    let message: T.ChatMessage;
    await run(async (f, x) => {
      x.holds = false;
      thread = await hireAndRun(f, x, "w15", "write route", "chat-route");
      message = (await f.chat.post({ _tag: "User", text: "recover this input", channel: thread.id, sendKey: "route-gap" })).message;
      await until(async () => (await f.deliveryOf("w15", message.id))?.state === "consumed", "the first route");
      await f.sql(`delete from mailbox_delivery where envelope_id = $1`, [message.id]);
      await f.sql(`update mailbox_trigger set routed_at = null, routing_scope = null, routing_position = null where id = $1`, [message.id]);
    }, config);
    await run(async (_f, x) => {
      x.holds = false;
      await until(() => x.runsOf("w15").some((input) => input.includes("recover this input")), "the recovered route");
    }, config);
  });

  test("regression: a message that cannot be routed is tried once at startup, not again and again", async () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    await run(async (f, x) => {
      x.holds = false;
      thread = await hireAndRun(f, x, "w16", "write route", "chat-stuck");
      const stuck = (await f.chat.post({ _tag: "User", text: "this one cannot be routed", channel: thread.id, sendKey: "stuck" })).message;
      await until(async () => (await f.deliveryOf("w16", stuck.id))?.state === "consumed", "the first route");
      // A receipt that no longer reads: routing it fails every time it is tried.
      await f.sql(`update mailbox_trigger set routed_at = null, routing_scope = null, routing_position = null, trigger_json = 'not json' where id = $1`, [
        stuck.id,
      ]);
    }, config);
    // The farm comes up past the row it cannot route, and takes new words.
    await withTimeout(
      () =>
        run(async (f, x) => {
          x.holds = false;
          await f.chat.post({ _tag: "User", text: "after the stuck one", channel: thread.id, sendKey: "after" });
          await until(() => x.runsOf("w16").some((input) => input.includes("after the stuck one")), "a message after the stuck one");
        }, config),
      20_000,
      { clock: systemClock, what: "the farm coming up past the stuck row" },
    );
  });

  test("an undeclared report's summary does not parse prose markers", () => {
    expect(summaryOf("先看看。\n\n**结论：** 改好了，测试通过。\n\n备注：无")).toContain("备注：无");
    expect(summaryOf("做了一些事\n\n- 结论：好了")).toBe("做了一些事\n\n- 结论：好了");
    expect(summaryOf("第一段\n\n第二段")).toBe("第一段\n\n第二段");
    expect(head("😀abc", 1)).toBe("");
  });

  test("a valid JSON message meta with the wrong shape fails fast", () =>
    run(async (f) => {
      const { message } = await f.chat.post({ _tag: "User", text: "带元数据", sendKey: "" });
      await qm.updateMessageMeta(f.db.sql, { meta: `{"mentions":{},"spent":{"tokens":1e999}}`, id: message.id });
      const read = await f.chat.history(f.chat.defaultChannel()).then(
        () => "read",
        (e: unknown) => messageOf(e),
      );
      expect(read).toContain("channel_message.meta");
    }));

  test("a message keeps the run that made it", () =>
    run(async (f, x) => {
      const general = f.chat.defaultChannel();
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: "complete", run: "run-first" });
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: "unlinked", run: "" });
      const saved = await f.chat.history(general);
      expect(saved.map((m) => [m.text, m.run])).toEqual([
        ["complete", "run-first"],
        ["unlinked", undefined],
      ]);
      await hireAndRun(f, x, "run-helper", "test run metadata", "chat-k");
      f.core.apply({
        type: "sessionReported",
        questions: [],
        checks: [],
        id: sessionId("run-helper"),
        outcome: "completed",
        summary: "done",
        run: "finished-run",
        runs: 2,
      });
      await until(
        () =>
          f
            .messagesOf(f.chat.defaultChannel())
            .concat(...(f.core.state().chat?.channels ?? []).map((c) => f.messagesOf(c.id)))
            .some((m) => m.from === "run-helper" && m.run === "finished-run"),
        "the report carries its run",
      );
    }));

  test("a room catches a follower up past its number, then tells it what is said there", () =>
    run(async (f) => {
      const general = f.chat.defaultChannel();
      for (const text of ["一", "二", "三"]) await f.chat.post({ _tag: "User", text: text, sendKey: "" });
      const one = (await f.chat.history(general)).find((m) => m.text === "一")!;
      const following = take(f.chat.follow(general, one.revision), 3);
      // What is said elsewhere is not this room's.
      const elsewhere = (await f.chat.openChannel("别处", "", "")).id;
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: elsewhere, text: "别处的话", run: "" });
      await until(() => f.messagesOf(elsewhere).length > 0, "said elsewhere");
      await f.chat.post({ _tag: "User", text: "四", sendKey: "send-4" });
      const got = await following;
      expect(got.map((e) => (e._tag === "Message" ? [e.message.number, e.message.text] : e._tag))).toEqual([
        [2, "二"],
        [3, "三"],
        [4, "四"],
      ]);
      // The user's own line carries its key: a page knows the line it sent.
      expect(got.map((e) => (e._tag === "Message" ? e.message.sendKey : undefined))).toEqual([undefined, undefined, "send-4"]);
    }));

  test("a message changes: replies, edits, deletions, reactions and pins, each caught up by revision", () => {
    const config = testConfig();
    return run(async (f) => {
      const general = f.chat.defaultChannel();
      const first = (await f.chat.post({ _tag: "User", text: "先这样", sendKey: "" })).message;
      expect((await f.chat.history(general))[0]!.reactions).toEqual([]);
      const reply = (await f.chat.post({ _tag: "User", text: "补一句", sendKey: "", replyTo: first.number })).message;
      expect(reply.replyTo).toBe(first.number);
      const saidFailure = await failure(f.chat.post({ _tag: "User", text: "没有这条", sendKey: "", replyTo: 99 }));
      expect(saidFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
      const since = (await f.chat.history(general)).at(-1)!.revision;

      const edited = await f.chat.edit(first.id, "改成这样");
      expect([edited.text, edited.edited !== undefined, edited.revision > since]).toEqual(["改成这样", true, true]);
      const theirs = (await f.chat.post({ _tag: "Agent", from: defaultOrchestrator, text: "我来看看", anyway: true, confirm: true })).message!;
      const editedFailure = await failure(f.chat.edit(theirs.id, "不是你的"));
      expect(editedFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
      const liked = await f.chat.react(theirs.id, "user", "👍", true);
      expect(liked.reactions).toEqual([{ emoji: "👍", by: ["user"] }]);
      // A set repeated (a retry) is no change: the same revision, the reaction once.
      const again = await f.chat.react(theirs.id, "user", "👍", true);
      expect([again.reactions, again.revision]).toEqual([liked.reactions, liked.revision]);
      const taken = await f.chat.react(theirs.id, "user", "👍", false);
      expect(taken.reactions).toEqual([]);
      expect((await f.chat.react(theirs.id, "user", "👍", false)).revision).toBe(taken.revision);
      const pinned = await f.chat.pin(reply.id, true);
      expect(pinned.pinned).toBeDefined();
      expect((await f.chat.pin(reply.id, true)).revision).toBe(pinned.revision);
      expect((await f.chat.pins(general)).map((m) => m.id)).toEqual([reply.id]);
      expect((await f.chat.previewRemove(theirs.id)).does[0]).toContain(`第 ${theirs.number} 条`);
      await f.chat.remove(theirs.id);
      const removedFailure = await failure(f.chat.remove(theirs.id));
      expect(removedFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });

      const caught = await take(f.chat.follow(general, since), 3);
      expect(caught.map((e) => (e._tag === "Message" ? [e.message.number, e.message.text, e.message.deleted !== undefined] : e._tag))).toEqual([
        [first.number, "改成这样", false],
        [reply.number, "补一句", false],
        [theirs.number, "", true],
      ]);
      const hits = await f.chat.search("补一");
      expect(hits.map((h) => [h.message.id, h.address])).toEqual([[reply.id, "#general"]]);
      const thread = await f.chat.threadUnder(reply.id);
      expect(f.channel(thread)?.root).toBe(reply.id);
      const threadUnder2 = await f.chat.threadUnder(reply.id);
      expect(threadUnder2).toBe(thread);

      const file = await f.attachment.attach({ name: "截图.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") });
      expect(file).toMatchObject({ name: "截图.png", type: "image/png", size: 9 });
      expect((await f.attachment.attach({ name: "again.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") })).id).toBe(file.id);
      const shown = (await f.chat.post({ _tag: "User", text: "", sendKey: "", attachments: [file.id] })).message;
      expect(shown.attachments).toEqual([file]);
      const kept = await f.attachment.get(file.id);
      expect(readFileSync(kept!.path, "utf8")).toBe("png bytes");
      expect((await f.chat.read(defaultOrchestrator, { target: "#general", limit: 1 })).messages[0]!.attachments).toEqual([
        { name: "截图.png", path: kept!.path },
      ]);
      const saidFailure2 = await failure(f.chat.post({ _tag: "User", text: "", sendKey: "", attachments: ["nope"] }));
      expect(saidFailure2).toMatchObject({ name: "ApiError", bizCode: BizCode.NotFound });
    }, config);
  });

  test("regression: an attachment that cannot be kept is refused with the file system's own words", () => {
    const config = testConfig();
    // A file where the attachments folder should be: making the folder fails, already existing.
    writeFileSync(join(config.home, "attachments"), "");
    return run(async (f) => {
      const refusal = await failure(f.attachment.attach({ name: "a.txt", type: "", data: Buffer.from("x").toString("base64") }));
      expect(refusal).toMatchObject({ name: "ApiError", bizCode: BizCode.AttachmentRefused, message: expect.stringMatching(/EEXIST|AlreadyExists/u) });
    }, config);
  });

  test("the farm's log hears every report: the newest ones first, then each as it is written", () =>
    run(async (f, x) => {
      await hireAndRun(f, x, "w21", "写 hello", "chat-k");
      const first = await take(f.chat.reports(), 1);
      const was = first[0]!._tag === "Message" ? first[0]!.message : undefined;
      expect([was?.kind, was?.from]).toEqual(["report", "w21"]);
      const next = take(f.chat.reports(was!.id), 1);
      await hireAndRun(f, x, "w22", "写 world", "chat-k");
      const got = await next;
      expect(got.map((e) => e._tag === "Message" && e.message.from)).toEqual(["w22"]);
    }));

  test("a follower too far behind is told to reload the room", () =>
    run(async (f) => {
      const general = f.chat.defaultChannel();
      for (let i = 0; i <= catchUpMax; i++) await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: `第 ${i} 句`, run: "" });
      const first = await take(f.chat.follow(general, 0), 1);
      expect(first).toEqual([{ _tag: "Reset" }]);
      const near = await take(f.chat.follow(general, 1), 1);
      expect(near.map((e) => e._tag === "Message" && e.message.number)).toEqual([2]);
      const drainOutcomeFailure = await failure(drain(f.chat.follow("no-such-room", 0)));
      expect(drainOutcomeFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.ChannelRefused });
    }));

  test("a send key writes once", () =>
    run(async (f) => {
      const first = await f.chat.post({ _tag: "User", text: "早", sendKey: "k1" });
      const second = await f.chat.post({ _tag: "User", text: "早", sendKey: "k1" });
      expect([first.again, second.again, second.message.id, second.message.number]).toEqual([false, true, first.message.id, first.message.number]);
      expect((await f.chat.post({ _tag: "User", text: "早", sendKey: "k2" })).again).toBe(false);
      for (let i = 0; i < 2; i++) expect((await f.chat.post({ _tag: "User", text: "晚", sendKey: "" })).again).toBe(false);
      const saidFailure = await failure(f.chat.post({ _tag: "User", text: "早", sendKey: "k".repeat(65) }));
      expect(saidFailure).toMatchObject({ message: "sendKey 太长" });
      for (let i = 0; i < 2; i++) await f.chat.post({ _tag: "Call", from: "user", text: "电话里说的", sendKey: "k3" });
      const users = () => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.from === "user");
      await until(() => users().length >= 5, "the user's lines heard");
      const said: Record<string, number> = {};
      for (const m of users()) said[m.text] = (said[m.text] ?? 0) + 1;
      expect(said).toEqual({ 早: 2, 晚: 2, 电话里说的: 1 });
      const deliveries2 = await f.deliveries(defaultOrchestrator);
      expect(deliveries2).toHaveLength(4);
    }));

  test("regression: channel fanout rolls back all recipients and replays the committed message once", () =>
    run(async (f, x) => {
      await hire(f, x, "w1", "first", "demo");
      await hire(f, x, "w2", "second", "demo");
      await trigger(f.db, "fail_second_recipient", "before insert on mailbox_delivery", "new.session_id = 'w2'");
      expect(await outcome(f.chat.post({ _tag: "User", text: "@w1 @w2 atomic fanout", sendKey: "fanout-key" }))).toBe("Failure");
      const [message] = await f.sql(`select id from channel_message where send_key = 'fanout-key'`);
      expect(message).toBeDefined();
      const id = String(message!["id"]);
      const rows = await f.sql(`select session_id from mailbox_delivery where envelope_id = $1`, [id]);
      expect(rows).toEqual([]);
      const registered2 = await f.mailbox.isRouted(id);
      expect(registered2).toBe(false);
      expect(f.mailbox.deliveriesOf("w1").some((row) => row.envelope_id === id)).toBe(false);
      await drop(f.db, "fail_second_recipient", "mailbox_delivery");
      await f.chat.start();
      await f.chat.start();
      const rows2 = await f.sql(`select session_id from mailbox_delivery where envelope_id = $1 order by session_id`, [id]);
      expect(rows2).toEqual([{ session_id: "w1" }, { session_id: "w2" }]);
      const registered3 = await f.mailbox.isRouted(id);
      expect(registered3).toBe(true);
    }));

  test("a read receipt is written whole or not at all", () =>
    run(async (f) => {
      const general = f.chat.defaultChannel();
      await f.chat.post({ _tag: "Run", from: defaultOrchestrator, channel: general, text: "hello", run: "" });
      const [message] = await f.chat.history(general);
      await trigger(f.db, "fail_receipt", "before insert on channel_read_cursor");
      expect(await outcome(f.chat.markRead(general, message!.number))).toBe("Failure");
      const rows = await f.sql(`select read_number from channel_read_cursor where participant_id = 'user' and channel_id = $1`, [general]);
      expect(rows).toEqual([]);
      // Nor is it read in what the chat shows next: what it kept in memory is read again from the database.
      await f.chat.post({ _tag: "Notice", channel: general, text: "动静", code: "test" });
      expect(f.channel(general)?.read).toBeUndefined();
      await drop(f.db, "fail_receipt", "channel_read_cursor");
      await f.chat.markRead(general, message!.number);
      const rows2 = await f.sql(`select read_number from channel_read_cursor where participant_id = 'user' and channel_id = $1`, [general]);
      expect(rows2).toEqual([{ read_number: message!.number }]);
      expect(f.channel(general)?.read).toBe(message!.number);
    }));

  test("a dispatch whose thread cannot take its member leaves no dispatch, and a second try writes one", () => {
    const log = keptLog("farm");
    return run(
      async (f) => {
        await trigger(f.db, "fail_user", "before insert on channel_member", "new.reason = 'user'");
        const first: T.Session = {
          id: sessionId("w1"),
          role: "worker",
          name: "helper",
          agent: "lab",
          runtime: "pi",
          brief: "work",
          hiredAt: Date.now(),
          runs: 0,
          phase: { _tag: "resting" },
          refining: false,
        };
        await keepSession(f, first);
        f.core.apply({
          type: "sessionChanged",
          session: first,
        });
        await waitFor(
          () => log.lines.filter((l) => l.line.includes("fail_user")).length,
          (n) => n > 0,
          "the dispatch tried and refused",
        );
        const history2 = await f.chat.history(f.chat.defaultChannel());
        expect(history2).toEqual([]);
        await drop(f.db, "fail_user", "channel_member");
        // Another hire opens every present session's thread again.
        const second: T.Session = {
          id: sessionId("w2"),
          role: "worker",
          name: "other",
          agent: "lab",
          runtime: "pi",
          brief: "more",
          hiredAt: Date.now(),
          runs: 0,
          phase: { _tag: "resting" },
          refining: false,
        };
        await keepSession(f, second);
        f.core.apply({
          type: "sessionChanged",
          session: second,
        });
        await until(() => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.kind === "dispatch").length === 2, "both dispatched");
        const thread = (await f.chat.threadOfSession("w1"))!;
        expect((await f.sql(`select participant_id from channel_member where channel_id = $1`, [thread])).map((r) => r.participant_id)).toEqual(["w1"]);
      },
      undefined,
      log,
    );
  });
});

test("regression: mailbox routing reads the current channel manager through threads and direct conversations", async () => {
  await using db = await openDb(testConfig(), keptLog(), wallTime);
  const sql = (text: string) => db.sql.exec(text);
  await sql(
    "insert into channel_participant (id, kind, role, name, joined_at) values ('manager', 'agent', 'orchestrator', 'manager', 0), ('first', 'agent', 'orchestrator', 'first', 0), ('second', 'agent', 'orchestrator', 'second', 0)",
  );
  await sql("insert into channel (id, type, name, created_at) values ('room', 'channel', 'room', 0)");
  await addMember(db.sql, { channel_id: "room", participant_id: "first", reason: "manual", from_number: 0 });
  await sql(`insert into channel_message (id, channel_id, number, sender_id, kind, body, created_at, revision)
      values ('root', 'room', 1, 'manager', 'chat', '', 0, 1)`);
  await sql("insert into channel (id, type, root_id, parent_id, created_at) values ('thread', 'thread', 'root', 'room', 0)");
  await sql("insert into channel (id, type, peer_id, created_at) values ('direct', 'direct', 'manager', 0)");
  // Every agent named here is taken for an orchestrator: what is under test is which place's members are read.
  const orchestratorHere = async (id: string) => {
    const top = await topPlace(db.sql, { id });
    if (top === undefined) throw new Error(`no place ${id}`);
    const rows = await membersOf(db.sql, { channel_id: top.id });
    return orchestratorIn({ top, members: rows.map((m) => m.participant_id), isOrchestrator: () => true });
  };
  const before = await orchestratorHere("thread");
  expect(before).toBe("first");
  await removeMember(db.sql, { channel_id: "room", participant_id: "first", at: 1 });
  await addMember(db.sql, { channel_id: "room", participant_id: "second", reason: "manual", from_number: 0 });
  const after = await orchestratorHere("thread");
  const direct = await orchestratorHere("direct");
  expect([after, direct]).toEqual(["second", "manager"]);
});
