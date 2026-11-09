import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Array as Arr, Effect, Fiber, Formatter, Layer, Metric, PubSub, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { channelOf, defaultOf, isBusy } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { head } from "#/base/clip.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { dbQueries, Database, Db } from "#/infra/db.ts";
import { wakeBreaker } from "#/mailbox/brakes.ts";
import { type Handed, orchestratorIn } from "#/mailbox/envelope.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { layer as projection } from "#/projection/frame.ts";
import { restoredSession, sessionState } from "#/session/history.ts";
import { summaryOf } from "#/session/report.ts";
import { sessionOnIssue } from "#/session/roster.ts";
import { Session, newsOf, type SessionNews } from "#/session/session.ts";
import type { Consumed, LaunchActivity } from "#/session/signals.ts";
import { testConfig, offline, testDatabase, until, waitFor } from "#/testing/layers.ts";
import { allow, heard, refuse } from "#/testing/refuse.ts";
import { Said, said } from "#/testing/world.ts";
import { topPlace } from "#db/channel.sql.ts";
import { addMember, membersOf, removeMember } from "#db/channel_member.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qsession from "#db/session.sql.ts";

import { Channel, catchUpMax, type Delivered } from "./channel.ts";

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
  core!: Core["Service"];
  news!: PubSub.PubSub<SessionNews>;
  consumed = (c: Consumed) => void PubSub.publishUnsafe(this.news, { _tag: "Consumed", ...c });

  runsOf = (id: string) => [...(this.inputs.get(id) ?? [])];
  steersOf = (id: string) => [...(this.steers.get(id) ?? [])];
  private publish = (a: LaunchActivity) => PubSub.publishUnsafe(this.news, a);
  private apply = (...f: Parameters<Core["Service"]["apply"]>) => Effect.runSync(this.core.apply(...f));

  deliver = (id: string, text: string, read: () => void = () => {}): Delivered => {
    if (!this.core.session(id)) return { kind: "refused", reason: "不在地里" };
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

/** The chat over played sessions: the pubs exist before the chat subscribes to them. */
const channelLayer = (x: FakeSessions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      x.core = yield* Core;
      const db = yield* Db;
      const activeSessions2 = yield* db.run(qsession.activeSessions());
      yield* Effect.forEach(activeSessions2, (row) => x.core.apply({ type: "sessionChanged", session: restoredSession(row) }), {
        discard: true,
      });
      yield* db.run(
        qsession.keepSession({
          id: defaultOrchestrator,
          role: "orchestrator",
          agent: defaultOrchestrator,
          name: "管家",
          runtime: "vibevalley",
          brief: "",
          repo: null,
          issue: null,
          channel: null,
          hired_at: 0,
        }),
      );
      x.news = yield* PubSub.unbounded<SessionNews>();
      const sessions = {
        isReachable: (id: string) => x.core.session(id) !== undefined,
        sessionOf: (id: string) => x.core.session(id),
        hired: () => x.core.state().sessions.filter((s) => s.role === "worker"),
        deliver: (id: string, text: string, input: Parameters<Session["Service"]["deliver"]>[2]) =>
          Effect.sync(() => x.deliver(id, text, () => x.consumed({ session: id, envelopeIds: [...input.envelopeIds] }))),
        runOf: () => undefined,
        reportOf: (id: string) => summaryOf(x.last.get(id) ?? ""),
        onIssue: (issue: string) => sessionOnIssue(x.core.state(), issue)?.id,
        news: Effect.map(PubSub.subscribe(x.news), Stream.fromSubscription),
      };
      return Channel.layer.pipe(Layer.provideMerge(Mailbox.layer), Layer.provideMerge(Layer.succeed(Session, sessions as unknown as Session["Service"])));
    }),
  );

/** The played sessions' own facts reach the chat, and the chats start once they are back. */
const fakeNews = (x: FakeSessions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const chat = yield* Channel;
      const mailbox = yield* Mailbox;
      const db = yield* Db;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.forEach(x.core.state().sessions, (session) => db.run(Effect.flatMap(sessionState(session), qsession.keepSessionState)), {
            discard: true,
          });
          x.stopped = true;
          x.release();
        }),
      );
      const [, moves] = yield* x.core.transitions;
      yield* Effect.forkScoped(
        Stream.runForEach(moves, ({ fact, after }) =>
          Effect.gen(function* () {
            if (fact.type === "sessionLeft") yield* db.run(qsession.endSession({ id: fact.id, closed: fact.closed ?? "dismissed", ended_at: fact.at }));
            const n = newsOf(fact, after);
            if (n) yield* PubSub.publish(x.news, n);
          }),
        ),
      );
      yield* chat.start;
      yield* mailbox.start;
    }),
  );

const world = (x: FakeSessions, config: ServerConfig["Service"] = testConfig()) => {
  const c: ServerConfig["Service"] = { ...config, chat: { noticeBatchMs: 300, retryWakeMs: 100 } };
  const delivery = channelLayer(x);
  return fakeNews(x).pipe(
    Layer.provideMerge(delivery),
    Layer.provideMerge(said),
    Layer.provideMerge(Agent.layer),
    Layer.provideMerge(Core.layer.pipe(Layer.provide(projection))),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Database),
    Layer.provideMerge(Layer.succeed(ServerConfig, c)),
    Layer.provideMerge(offline),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** The services of a test, and its helpers. */
const farm = Effect.gen(function* () {
  const context2 = yield* Effect.context();
  const runPromise = Effect.runPromiseWith(context2);
  const core = yield* Core;
  const chat = yield* Channel;
  const mailbox = yield* Mailbox;
  const sql = yield* SqlClient.SqlClient;
  const messagesOf = (yield* Said).in;
  const channel = (id: string | undefined) => (id ? channelOf(core.state().chat, id) : undefined);
  const deliveries = (recipient: string) =>
    runPromise(
      sql<{
        envelope_id: string;
        reason: string;
        wakes: boolean;
        held_by: string;
        state: string;
      }>`select envelope_id, reason, wakes, coalesce(held_by, '') as held_by, state from mailbox_delivery where session_id = ${recipient} order by envelope_id`,
    );
  const deliveryOf = async (recipient: string, message: string) => (await deliveries(recipient)).find((d) => d.envelope_id === message);
  return { core, chat, mailbox, sql, messagesOf, channel, deliveries, deliveryOf };
});

type Farm = Effect.Success<typeof farm>;

const keepSession = (f: Farm, session: T.Session) =>
  f.sql`insert into session (id, role, agent, name, runtime, brief, repo, issue, channel, hired_at, phase, refining, runs)
        values (${session.id}, ${session.role}, ${session.agent}, ${session.name}, ${session.runtime}, ${session.brief}, ${session.repo ?? null},
                ${session.issue ?? null}, ${session.channel ?? null}, ${session.hiredAt}, ${Formatter.formatJson(session.phase)}, ${session.refining}, ${session.runs})
        on conflict (id) do nothing`;

const hire = (f: Farm, x: FakeSessions, id: string, brief: string, repo: string, channel?: string, issue?: string) =>
  Effect.gen(function* () {
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
    yield* keepSession(f, session);
    yield* f.core.apply({
      type: "sessionChanged",
      session,
    });
    const thread = yield* waitFor(Effect.map(f.chat.threadOfSession(id), f.channel), (c) => c !== undefined, "an issue thread");
    return thread!;
  });

/** Hired, and its first turn reported in its thread. */
const hireAndRun = (f: Farm, x: FakeSessions, id: string, brief: string, repo: string, channel?: string) =>
  Effect.gen(function* () {
    const thread = yield* hire(f, x, id, brief, repo, channel);
    expect(x.deliver(id, brief).kind).toBe("run");
    yield* until(() => f.messagesOf(thread.id).some((m) => m.kind === "report" && m.from === id), "its first report");
    return thread;
  });

const news = (f: Farm) =>
  Effect.gen(function* () {
    const heard: Handed[] = [];
    const news2 = yield* f.mailbox.news;
    yield* Effect.forkScoped(Stream.runForEach(news2, (n) => Effect.sync(() => void (n._tag === "Handed" && heard.push(n)))));
    return {
      of: (message: string) =>
        Effect.gen(function* () {
          yield* until(() => heard.some((n) => n.messages.some((m) => m.id === message)), `the orchestrator hearing of ${message}`);
          return heard.find((n) => n.messages.some((m) => m.id === message))!;
        }),
    };
  });

const run = <A, E>(
  body: (f: Farm, x: FakeSessions) => Effect.Effect<A, E, Core | Channel | Mailbox | SqlClient.SqlClient | Scope.Scope>,
  config?: ServerConfig["Service"],
  /** What the farm logs to besides (heard). */
  logs: Layer.Layer<never> = Layer.empty,
) => {
  const x = new FakeSessions();
  return Effect.flatMap(farm, (f) => body(f, x)).pipe(Effect.scoped, Effect.provide(world(x, config).pipe(Layer.provide(logs))));
};

describe("the chat", () => {
  it.live("regression: freshness pages advance the read cursor without skipping older messages", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w-page", "work", "paging-repo");
        const channel = yield* f.chat.openChannel("paging", "", "");
        for (const text of ["first", "second", "third", "fourth", "fifth"]) yield* f.chat.say(text, channel.id, "");
        const options = { target: "#paging", confirm: true };
        const first = yield* f.chat.speak("w-page", "reply", options);
        expect(first.shown?.map((message) => message.text)).toEqual(["first", "second", "third"]);
        expect(first.more).toBe(2);
        const rows = yield* f.sql`select read_number from channel_read_cursor where participant_id = 'w-page' and channel_id = ${channel.id}`;
        expect(rows).toEqual([{ read_number: 3 }]);
        const second = yield* f.chat.speak("w-page", "reply", options);
        expect(second.shown?.map((message) => message.text)).toEqual(["fourth", "fifth"]);
        expect(second.more).toBe(0);
        expect((yield* f.chat.speak("w-page", "reply", options)).kind).toBe("sent");
      }),
    ),
  );
  it.live("a line said to an orchestrator reaches it alone, even where no one is in; said to a helper it is refused", () =>
    run((f) =>
      Effect.gen(function* () {
        const quiet = (yield* f.chat.openChannel("quiet", "", "")).id;
        yield* f.chat.updateChannel(quiet, { members: [] });
        // Routing is done when say returns: the deliveries are written with the message.
        const unheard = (yield* f.chat.say("有人吗", quiet, "")).message;
        const asked = (yield* f.chat.say("/imagegen 一只在麦田里打盹的橘猫", quiet, "", { to: defaultOrchestrator })).message;
        const toNoOne = yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, unheard.id));
        const toIt = yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, asked.id));
        expect([toNoOne, toIt?.reason]).toEqual([undefined, "addressed"]);
        const refused = yield* Effect.flip(f.chat.say("画一张", quiet, "", { to: "lab" }));
        expect(refused).toMatchObject({ _tag: "Refused" });
      }),
    ),
  );
  it.live("regression: publishing to the orchestrator does not acknowledge model consumption", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const heard = yield* news(f);
        const message = (yield* f.chat.say("等实际入模", undefined, "")).message;
        yield* heard.of(message.id);
        expect((yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, message.id)))?.state).toBe("handed");
        expect((yield* f.chat.history(f.chat.defaultChannel())).find((item) => item.id === message.id)?.reactions).toEqual([]);
        yield* f.chat.read(defaultOrchestrator, { target: "#general" });
        expect((yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, message.id)))?.state).toBe("handed");
        x.consumed({ session: defaultOrchestrator, envelopeIds: [message.id] });
        yield* until(async () => (await f.deliveryOf(defaultOrchestrator, message.id))?.state === "consumed", "the model consumption receipt");
        expect((yield* f.chat.history(f.chat.defaultChannel())).find((item) => item.id === message.id)?.reactions).toEqual([
          { emoji: "👀", by: [defaultOrchestrator] },
        ]);
      }),
    ),
  );
  // A budget, at what it takes today: one line from the owner in the general channel, written, delivered and told. A change that asks more fails here.
  it.live("one line from the owner reads and writes the database a bounded number of times", () =>
    run((f) =>
      Effect.gen(function* () {
        yield* f.chat.say("先暖一下", undefined, "");
        const before = (yield* Metric.value(dbQueries)).count;
        yield* f.chat.say("今天进度怎么样", undefined, "");
        const used = (yield* Metric.value(dbQueries)).count - before;
        expect(used).toBeGreaterThan(0);
        expect(used, `${used} queries`).toBeLessThanOrEqual(17);
      }),
    ),
  );

  it.live("a dispatched issue opens a thread under its dispatch", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w1", "写 hello", "chat-a");
        const general = defaultOf(f.core.state().chat)!;
        expect(general.id).toBe(f.chat.defaultChannel());
        const dispatch = f.messagesOf(general.id).find((m) => m.kind === "dispatch" && m.session === "w1")!;
        expect(thread.root).toBe(dispatch.id);
        expect(dispatch.text).toContain("派 @w1（帮工w1）去 chat-a：写 hello");
        const report = f.messagesOf(thread.id).findLast((m) => m.kind === "report")!;
        expect([report.from, report.fromKind, report.outcome]).toEqual(["w1", "session", "completed"]);
        expect(report.text).toContain("收到了");
        expect(report.text).not.toContain("结论");
        const threadOfSession2 = yield* f.chat.threadOfSession("w1");
        expect(threadOfSession2).toBe(thread.id);
      }),
    ),
  );

  it.live("a session sent for no issue has a talk thread", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const talk = yield* hireAndRun(f, x, "w1", "写 hello", "chat-t");
        expect([talk.subjectKind, talk.subjectId]).toEqual(["talk", "w1"]);
        const dispatched = yield* hire(f, x, "w2", "写 world", "chat-t", undefined, "i1");
        expect([dispatched.subjectKind, dispatched.subjectId, dispatched.id !== talk.id]).toEqual(["issue", "i1", true]);
        yield* f.chat.say("把输出改成中文", talk.id, "");
        yield* until(() => x.runsOf("w1").length >= 2, "a second turn");
      }),
    ),
  );

  it.live("the owner's words in an issue thread wake its session", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w2", "写 hello", "chat-b");
        const { message: said } = yield* f.chat.say("把输出改成中文", thread.id, "");
        yield* until(() => x.runsOf("w2").length >= 2, "a second turn");
        expect(x.runsOf("w2")[1]).toContain(`[target=#general:${thread.rootNumber} msg=${said.number} from=主人] 把输出改成中文`);
        yield* until(async () => (await f.deliveryOf("w2", said.id))?.state === "consumed", "consumed");
        yield* until(() => f.messagesOf(thread.id).filter((m) => m.kind === "report").length >= 2, "its reply in the thread");
      }),
    ),
  );

  it.live("the general channel reaches the orchestrator", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w3", "写 hello", "chat-c");
        const heard = yield* news(f);
        const before = x.runsOf("w3").length;
        const { message: said } = yield* f.chat.say("今天进度怎么样", undefined, "");
        const n = yield* heard.of(said.id);
        expect([n.messages.length, n.messages[0]!.text, n.target, n.channel]).toEqual([1, "今天进度怎么样", "#general", f.chat.defaultChannel()]);
        // Who is handed what is settled before say returns: a session not woken by now is not woken by it.
        expect(x.runsOf("w3")).toHaveLength(before);
        const deliveryOf2 = yield* Effect.promise(() => f.deliveryOf("w3", said.id));
        expect(deliveryOf2).toMatchObject({ reason: "channel", wakes: 0 });
        const deliveryOf3 = yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, said.id));
        expect(deliveryOf3).toMatchObject({ state: "handed" });
      }),
    ),
  );

  it.live("the owner talks with the orchestrator alone in their direct channel", () => {
    const config = { ...testConfig(), db: "" };
    const directs = (f: Farm) => (f.core.state().chat?.channels ?? []).filter((c) => c.type === "direct");
    return Effect.gen(function* () {
      yield* run(
        (f, x) =>
          Effect.gen(function* () {
            yield* hireAndRun(f, x, "w3", "写 hello", "chat-d");
            const [direct, ...more] = directs(f);
            expect([direct?.peer, direct?.title, more.length]).toEqual([defaultOrchestrator, "管家", 0]);
            const heard = yield* news(f);
            const before = x.runsOf("w3").length;
            const { message: said } = yield* f.chat.say("@w3 你先别动，我们单独说", direct!.id, "");
            const n = yield* heard.of(said.id);
            expect([n.channel, n.type, n.target]).toEqual([direct!.id, "direct", "@owner"]);
            const deliveryOf2 = yield* Effect.promise(() => f.deliveryOf(defaultOrchestrator, said.id));
            expect(deliveryOf2).toMatchObject({ reason: "direct", wakes: 1 });
            const deliveryOf3 = yield* Effect.promise(() => f.deliveryOf("w3", said.id));
            expect(deliveryOf3).toBeUndefined();
            expect(x.runsOf("w3")).toHaveLength(before);
            expect(f.messagesOf(direct!.id).at(-1)?.mentions).toEqual([]);
            yield* f.chat.orchestratorSays(direct!.id, "好，说吧", "", defaultOrchestrator);
            yield* until(() => (f.channel(direct!.id)?.unread ?? 0) === 1, "the answer unread");
            expect((yield* f.chat.read(defaultOrchestrator, { target: "@主人" })).messages.map((m) => m.text)).toEqual([
              "@w3 你先别动，我们单独说",
              "好，说吧",
            ]);
            const addressOf2 = yield* f.chat.addressOf(direct!.id);
            expect(addressOf2).toEqual({ direct: true, target: "@owner" });
            expect((yield* f.chat.topOf(direct!.id)).id).toBe(f.chat.defaultChannel());
            const chatFailure = yield* Effect.flip(f.chat.read("w3", { target: "@owner" }));
            expect(chatFailure).toMatchObject({ reason: expect.stringContaining("没有私聊") });
            expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["general"]);
            const defaultFailure = yield* Effect.flip(f.chat.makeDefault(direct!.id));
            expect(defaultFailure).toMatchObject({ _tag: "Refused" });
          }),
        config,
      );
      yield* run((g) => Effect.sync(() => expect(directs(g)).toHaveLength(1)), config);
    });
  });

  it.live("a channel is renamed, grouped, placed, archived, quieted, and deleted once nothing points at it", () =>
    run((f) =>
      Effect.gen(function* () {
        const a = (yield* f.chat.openChannel("aa", "", "")).id;
        const b = (yield* f.chat.openChannel("bb", "", "")).id;
        yield* f.chat.updateChannel(a, { name: "前端", category: "仓库" });
        expect(f.channel(a)).toMatchObject({ name: "前端", category: "仓库" });
        const channelUpdatedFailure = yield* Effect.flip(f.chat.updateChannel(b, { name: "前端" }));
        expect(channelUpdatedFailure).toMatchObject({ _tag: "Refused" });
        yield* f.chat.updateChannel(b, { before: a });
        expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["general", "bb", "前端"]);

        const said = (yield* f.chat.say("一句话", a, "")).message;
        const thread = yield* f.chat.threadUnder(said.id);
        expect(f.channel(thread)?.title).toBe("一句话");
        yield* f.chat.updateChannel(thread, { name: "细说" });
        expect(f.channel(thread)?.title).toBe("细说");
        const channelUpdatedFailure2 = yield* Effect.flip(f.chat.updateChannel(thread, { category: "x" }));
        expect(channelUpdatedFailure2).toMatchObject({ _tag: "Refused" });

        yield* f.chat.archive(a, true);
        const archived = f.channel(a)?.archived;
        expect(archived).toBeDefined();
        // Set as it already is: nothing changes, not even when it was archived.
        yield* f.chat.archive(a, true);
        expect(f.channel(a)?.archived).toBe(archived);
        yield* f.chat.archive(a, false);
        expect(f.channel(a)?.archived).toBeUndefined();
        yield* f.chat.archive(a, false);
        expect(f.channel(a)?.archived).toBeUndefined();
        const archiveFailure = yield* Effect.flip(f.chat.archive(f.chat.defaultChannel(), true));
        expect(archiveFailure).toMatchObject({ _tag: "Refused" });

        yield* f.chat.speak(defaultOrchestrator, "随便说说", { target: "#前端", anyway: true, confirm: true });
        yield* f.chat.setNotify(a, "mentions");
        expect(f.channel(a)?.unread).toBeUndefined();
        yield* f.chat.speak(defaultOrchestrator, "@主人 看一下", { target: "#前端", anyway: true, confirm: true });
        expect(f.channel(a)?.unread).toBe(1);
        expect(f.chat.notifyOf(thread)).toBe("mentions");
        yield* f.chat.setNotify(a, "none");
        expect([f.channel(a)?.unread, f.core.state().chat?.ownerMentions.length ?? 0, f.chat.notifyOf(thread)]).toEqual([undefined, 0, "none"]);

        yield* f.chat.setNotify(a, "all");
        yield* f.chat.markRead(a, 99);
        yield* f.chat.markUnread(a, said.number);
        expect([f.channel(a)?.read, f.channel(a)?.unread]).toEqual([said.number - 1, 2]);

        // A cron of the cron module's, as its table has it.
        yield* f.sql`insert into cron (id, name, body, channel_id, spec, tz, created_at) values ('r1', '看看', '看一眼', ${a}, '{}', 'UTC', 0)`.pipe(
          Effect.orDie,
        );
        const channelRemovedFailure = yield* Effect.flip(f.chat.removeChannel(a));
        expect(channelRemovedFailure).toMatchObject({ reason: expect.stringContaining("定时任务") });
        const channelRemovedFailure2 = yield* Effect.flip(f.chat.removeChannel(f.chat.defaultChannel()));
        expect(channelRemovedFailure2).toMatchObject({ _tag: "Refused" });
        expect((yield* f.chat.previewRemoveChannel(b)).does[0]).toContain("#bb");
        yield* f.chat.removeChannel(b);
        expect([f.channel(b), (yield* f.chat.channels()).map((c) => c.name)]).toEqual([undefined, ["general", "前端"]]);
      }),
    ),
  );

  it.effect("regression: deleting a channel forgets the last read of its child threads", () =>
    run((f) =>
      Effect.gen(function* () {
        const channel = yield* f.chat.openChannel("temporary", "", "");
        const root = (yield* f.chat.say("a thread", channel.id, "")).message;
        yield* f.chat.threadUnder(root.id);
        yield* f.chat.read(defaultOrchestrator, { target: `#temporary:${root.number}` });
        yield* f.chat.removeChannel(channel.id);
        expect((yield* f.chat.speak(defaultOrchestrator, "back here", { target: "#general", anyway: true })).kind).toBe("sent");
      }),
    ),
  );

  it.live("a search reads its filters, and an edit can take a message's files off", () =>
    run((f) =>
      Effect.gen(function* () {
        const context2 = yield* Effect.context();
        const runPromise = Effect.runPromiseWith(context2);
        const general = f.chat.defaultChannel();
        const file = yield* f.chat.attach({ name: "图.png", type: "image/png", data: Buffer.from("x").toString("base64") });
        const pictured = (yield* f.chat.say("看图", undefined, "", { attachments: [file.id] })).message;
        yield* f.chat.say("一个链接 https://example.com/page", undefined, "");
        yield* f.chat.speak(defaultOrchestrator, "我看了图", { anyway: true, confirm: true });
        const text = async (q: string) => (await runPromise(f.chat.search(q))).map((h) => h.message.text);
        const text2 = yield* Effect.promise(() => text("has:image"));
        expect(text2).toEqual(["看图"]);
        const text3 = yield* Effect.promise(() => text("has:link"));
        expect(text3).toEqual(["一个链接 https://example.com/page"]);
        const text4 = yield* Effect.promise(() => text("图 from:管家"));
        expect(text4).toEqual(["我看了图"]);
        const text5 = yield* Effect.promise(() => text("from:主人 in:#general 图"));
        expect(text5).toEqual(["看图"]);
        const text6 = yield* Effect.promise(() => text("图 before:2000-01-01"));
        expect(text6).toEqual([]);
        const chatsFailure = yield* Effect.flip(f.chat.search("in:#nowhere"));
        expect(chatsFailure).toMatchObject({ _tag: "Missing" });

        const bare = yield* f.chat.edit(pictured.id, "看图（图去掉了）", []);
        expect([bare.attachments, bare.text]).toEqual([[], "看图（图去掉了）"]);
        expect((yield* f.chat.history(general)).find((m) => m.id === pictured.id)?.attachments).toEqual([]);
      }),
    ),
  );

  it.live("channels", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const channel = yield* f.chat.openChannel("#clock-in", "打卡页", "chat-ch");
        expect(channel).toMatchObject({ name: "clock-in", repo: "chat-ch", description: "打卡页" });
        const channelFailure = yield* Effect.flip(f.chat.openChannel("clock-in", "", ""));
        expect(channelFailure).toMatchObject({ reason: expect.stringContaining("已经有") });
        expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["general", "clock-in"]);
        const thread = yield* hireAndRun(f, x, "w4", "写 hello", "chat-ch", channel.id);
        expect(thread.parent).toBe(channel.id);
        const dispatch = f.messagesOf(channel.id).find((m) => m.kind === "dispatch" && m.session === "w4");
        expect(thread.root).toBe(dispatch?.id);
        yield* hireAndRun(f, x, "w5", "写 hello", "chat-sq");
        const heard = yield* news(f);
        const { message: said } = yield* f.chat.say("打卡页今天能好吗", channel.id, "");
        const n = yield* heard.of(said.id);
        expect([n.channel, n.target]).toEqual([channel.id, "#clock-in"]);
        const deliveryOf2 = yield* Effect.promise(() => f.deliveryOf("w4", said.id));
        expect(deliveryOf2).toMatchObject({ reason: "channel" });
        const deliveryOf3 = yield* Effect.promise(() => f.deliveryOf("w5", said.id));
        expect(deliveryOf3).toBeUndefined();
        expect((yield* f.chat.read("w4", { target: "#clock-in" })).target).toBe("#clock-in");
        expect((yield* f.chat.speak("w4", "今天能好", { target: "#clock-in", anyway: true, confirm: true })).kind).toBe("sent");
        const chatFailure = yield* Effect.flip(f.chat.read("w4", { target: "#nowhere" }));
        expect(chatFailure).toMatchObject({
          _tag: "Missing",
          what: expect.stringContaining("没有叫 #nowhere 的频道"),
        });
        expect((yield* f.chat.topOf(thread.id)).name).toBe("clock-in");
        yield* f.chat.updateChannel(channel.id, { repo: "" });
        const channelByName2 = yield* f.chat.channelByName("clock-in");
        expect(channelByName2).toMatchObject({ repo: "", description: "打卡页" });
        expect(channelOf(f.core.state().chat, channel.id)?.repo).toBeUndefined();
        const general = f.chat.defaultChannel();
        yield* f.chat.makeDefault(channel.id);
        expect([f.chat.defaultChannel(), defaultOf(f.core.state().chat)?.id, channelOf(f.core.state().chat, general)?.default]).toEqual([
          channel.id,
          channel.id,
          false,
        ]);
        expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["clock-in", "general"]);
        expect((yield* f.chat.say("没写频道", undefined, "")).message.channel).toBe(channel.id);
      }),
    ),
  );

  it.live("regression: a busy session gets the full input burst in one steer", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hire(f, x, "w6", "慢慢做一个大活", "chat-d");
        x.deliver("w6", "慢慢做一个大活");
        expect(isBusy(f.core.session("w6")!)).toBe(true);
        yield* f.chat.say("补充：顺便写测试", thread.id, "");
        yield* f.chat.say("还有：写 README", thread.id, "");
        yield* until(() => x.steersOf("w6").some((s) => s.includes("顺便写测试") && s.includes("写 README")), "the full input burst");
        expect(x.steersOf("w6")).toHaveLength(1);
        yield* until(async () => (await f.deliveries("w6")).every((row) => row.state === "consumed"), "the steered inputs consumed");
        x.release();
        expect(x.runsOf("w6")).toHaveLength(1);
      }),
    ),
  );

  it.live("regression: speaking before turn end does not consume an unacknowledged input", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hire(f, x, "w6", "work", "unconsumed");
        const acknowledge = x.consumed;
        x.consumed = () => {};
        const message = (yield* f.chat.say("followup without a model receipt", thread.id, "")).message;
        yield* until(
          async () => x.runsOf("w6").length > 0 && (await f.deliveryOf("w6", message.id))?.state === "pending",
          "the spoken but unconsumed input returned",
        );
        x.consumed = acknowledge;
        yield* until(async () => (await f.deliveryOf("w6", message.id))?.state === "consumed", "the retried input consumed");
        expect(x.runsOf("w6").length).toBeGreaterThan(1);
        expect(x.runsOf("w6").at(-1)).toContain("followup without a model receipt");
      }),
    ),
  );

  it.live("a line told to a session with no thread is a recorded trigger delivered to it alone", () =>
    run((f) =>
      Effect.gen(function* () {
        // Only workers get a thread: a second orchestrator session is present and has none.
        const session: T.Session = {
          id: sessionId("o2"),
          role: "orchestrator",
          name: "另一个管家",
          agent: "lab",
          runtime: "pi",
          brief: "",
          repo: "",
          hiredAt: Date.now(),
          runs: 0,
          phase: { _tag: "resting" },
          refining: false,
        };
        yield* keepSession(f, session);
        yield* f.core.apply({ type: "sessionChanged", session });
        const thread = yield* f.chat.threadOfSession("o2");
        expect(thread).toBeUndefined();
        yield* f.chat.tellSession(ownerId, "o2", "直接说给它", "");
        const recorded = yield* f.sql<{ id: string }>`select id from mailbox_trigger where trigger_json like ${"%直接说给它%"}`;
        expect(recorded).toHaveLength(1);
        yield* until(async () => (await f.deliveryOf("o2", recorded[0]!.id)) !== undefined, "its delivery");
        const delivered = yield* Effect.promise(() => f.deliveryOf("o2", recorded[0]!.id));
        expect(delivered).toMatchObject({ reason: "addressed", held_by: "" });
      }),
    ),
  );

  it.live("helpers calling each other stop at the hop limit", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w7", "写 hello", "chat-e");
        // The orchestrator is never cooled down, so only the hop limit holds.
        for (let i = 1; i <= 5; i++) expect((yield* f.chat.speak("w7", `@管家 第 ${i} 次问`, { anyway: true })).kind).toBe("sent");
        const held = (yield* Effect.promise(() => f.deliveries(defaultOrchestrator))).filter((d) => d.reason === "mention").map((d) => d.held_by);
        expect(held).toEqual(["", "", "", "", "hop_limit"]);
        const notices = f.messagesOf(thread.id).filter((m) => m.kind === "notice");
        expect(notices).toHaveLength(1);
        expect(notices[0]!.text).toContain("来回 4 次");
      }),
    ),
  );

  it.live("a session that fails every wake is not woken again until the owner says so", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const a = yield* hireAndRun(f, x, "w8", "写 hello", "chat-f");
        yield* hireAndRun(f, x, "w9", "写 world", "chat-g");
        yield* f.chat.say("@w8 这次必败", undefined, "");
        yield* until(() => f.messagesOf(a.id).some((m) => m.kind === "notice" && m.text.includes("一叫醒就失败")), "the breaker notice");
        expect(x.runsOf("w8")).toHaveLength(1 + wakeBreaker);
        for (const d of yield* Effect.promise(() => f.deliveries("w8"))) if (d.reason === "mention") expect(d.state).toBe("pending");
        expect((yield* f.chat.speak("w9", "@w8 你那边怎么样", { anyway: true })).kind).toBe("sent");
        expect((yield* Effect.promise(() => f.deliveries("w8"))).at(-1)?.held_by).toBe("wake_breaker");
        yield* f.chat.say("@w8 再试一次", undefined, "");
        yield* until(() => x.runsOf("w8").at(-1)!.includes("再试一次"), "woken by the owner");
      }),
    ),
  );

  it.live("speaking: retries, what it has not seen, confirming a channel, absent names and threads", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w10", "写 hello", "chat-h");
        const first = yield* f.chat.speak("w10", "我先看看代码");
        const again = yield* f.chat.speak("w10", "我先看看代码");
        expect([first.kind, again.kind, again.message?.id]).toEqual(["sent", "sent", first.message?.id]);
        const { message: words } = yield* f.chat.say("先别动 main", thread.id, "");
        const held = yield* f.chat.speak("w10", "我改好了");
        expect([held.kind, held.shown?.map((m) => m.id)]).toEqual(["held", [words.id]]);
        expect((yield* f.chat.speak("w10", "我改好了")).kind).toBe("sent");
        yield* f.chat.read("w10");
        const asked = yield* f.chat.speak("w10", "大家好", { target: "#general" });
        expect([asked.kind, asked.lastRead]).toEqual(["confirm", `#general:${thread.rootNumber}`]);
        expect((yield* f.chat.speak("w10", "大家好", { target: "#general", confirm: true, anyway: true })).kind).toBe("sent");
        const absent = yield* f.chat.speak("w10", "@w99 你在吗", { anyway: true });
        expect([absent.kind, absent.absent]).toEqual(["sent", ["w99"]]);
        const spokenFailure = yield* Effect.flip(f.chat.speak("w10", "hi", { target: "#general:999999" }));
        expect(spokenFailure).toMatchObject({
          reason: expect.stringContaining("没有 999999 这条消息"),
        });
        const { message: sq } = yield* f.chat.say("大家早", f.chat.defaultChannel(), "");
        const talk = yield* f.chat.speak("w10", "早", { target: `#general:${sq.number}`, anyway: true });
        expect([talk.kind, talk.target]).toEqual(["sent", `#general:${sq.number}`]);
        const under = f.core.state().chat?.channels.find((c) => c.root === sq.id);
        expect(under?.subjectKind).toBe("talk");
      }),
    ),
  );

  it.live("the orchestrator's words are written once, whole, and delivered", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w11", "写 hello", "chat-k");
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "  ", "", defaultOrchestrator);
        const ours = () => f.messagesOf(general).filter((m) => m.from === defaultOrchestrator && m.kind === "chat");
        expect(ours()).toEqual([]);
        yield* f.chat.orchestratorSays(general, "好的，我叫 @w11 去看看", "", defaultOrchestrator);
        expect(ours().map((m) => [m.text, m.mentions])).toEqual([["好的，我叫 @w11 去看看", ["w11"]]]);
        yield* until(() => x.runsOf("w11").length >= 2 && x.runsOf("w11")[1]!.includes("我叫 @w11 去看看"), "w11 woken");
        yield* f.chat.notice(general, "定时任务到了", "cron");
        yield* until(() => f.messagesOf(general).some((m) => m.kind === "notice" && m.text === "定时任务到了"), "the notice");
        const last = f.messagesOf(general).at(-1)!;
        expect([last.kind, last.from]).toEqual(["notice", "system"]);
        expect((yield* Effect.promise(() => f.deliveries("w11"))).at(-1)?.envelope_id).not.toBe(last.id);
      }),
    ),
  );

  it.live("history, pages and marking read", () =>
    run((f) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        const seqs: number[] = [];
        for (let i = 0; i < 5; i++) seqs.push((yield* f.chat.say(`第 ${i} 句`, general, "")).message.number);
        const got = yield* f.chat.history(general, seqs[4], 2);
        expect(got.map((m) => m.number)).toEqual([seqs[2], seqs[3]]);
        const page = yield* f.chat.read("owner", { target: "#general", before: seqs[4]!, limit: 2 });
        expect([page.messages.map((m) => m.number), page.older]).toEqual([[seqs[2], seqs[3]], true]);
        const older = yield* f.chat.read("owner", { target: "#general", before: page.messages[0]!.number, limit: 2 });
        expect([older.messages.map((m) => m.number), older.older]).toEqual([[seqs[0], seqs[1]], false]);
        yield* f.chat.markRead(general, seqs[1]!);
        expect((yield* Effect.flip(f.chat.markRead("nope", 1)))._tag).toBe("Missing");
        expect(defaultOf(f.core.state().chat)?.read).toBe(seqs[4]);
        expect((yield* Effect.flip(f.chat.say("  ", undefined, "")))._tag).toBe("Refused");
        const orchestratorDigest2 = yield* f.mailbox.orchestratorDigest(defaultOrchestrator);
        expect(orchestratorDigest2).toEqual([]);
      }),
    ),
  );

  it.live("the inbox and the orchestrator's digest", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w12", "写 hello", "chat-l");
        const digest = yield* f.mailbox.orchestratorDigest(defaultOrchestrator);
        expect(digest.map((d) => [d.from, d.target])).toEqual([["w12", `#general:${thread.rootNumber}`]]);
        const orchestratorDigest2 = yield* f.mailbox.orchestratorDigest(defaultOrchestrator);
        expect(orchestratorDigest2).toHaveLength(1);
        // Taken as input by the orchestrator's run, as its execution says once it took it.
        x.consumed({ session: defaultOrchestrator, envelopeIds: [digest[0]!.id] });
        yield* waitFor(f.mailbox.orchestratorDigest(defaultOrchestrator), (rows) => rows.length === 0, "the digest input consumed");
        yield* f.chat.say("大家看一下", f.chat.defaultChannel(), "");
        const unread = yield* f.chat.unread("w12");
        expect(unread).toEqual([{ channel: "#general", unread: 2, mentionsYou: true, latest: "主人" }]);
        yield* f.chat.read("w12", { target: "#general" });
        const unread2 = yield* f.chat.unread("w12");
        expect(unread2).toEqual([]);
      }),
    ),
  );

  it.live("a session that leaves has what was for it dropped", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w13", "写 hello", "chat-m");
        yield* until(() => !isBusy(f.core.session("w13")!), "resting");
        yield* f.chat.say("随便说说", f.chat.defaultChannel(), "");
        yield* f.core.apply({ type: "sessionLeft", id: sessionId("w13") });
        yield* until(async () => (await f.deliveries("w13")).at(-1)?.state === "dropped", "dropped");
        const left = yield* f.sql<{ left_at: number | null }>`select left_at from channel_participant where id = 'w13'`;
        expect(left[0]?.left_at).not.toBeNull();
      }),
    ),
  );

  it.live("after a restart what was handed is given again", () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    let said: T.ChatMessage;
    return Effect.gen(function* () {
      yield* run(
        (f, x) =>
          Effect.gen(function* () {
            thread = yield* hireAndRun(f, x, "w14", "写 hello", "chat-i");
            said = (yield* f.chat.say("慢慢做：再加一个文件", thread.id, "")).message;
            yield* until(async () => (await f.deliveryOf("w14", said.id))?.state === "handed", "handed");
          }),
        config,
      );
      yield* run(
        (g, y) =>
          Effect.gen(function* () {
            y.holds = false;
            expect(g.core.session("w14")).toBeDefined();
            yield* g.core.apply({
              type: "sessionReported",
              questions: [],
              checks: [],
              id: sessionId("w14"),
              outcome: "interrupted",
              summary: "重启了",
              runs: 1,
            });
            yield* until(async () => (await g.deliveryOf("w14", said.id))?.state === "consumed", "seen after the restart");
            expect(y.runsOf("w14").at(-1)).toContain("再加一个文件");
            const threadOfSession2 = yield* g.chat.threadOfSession("w14");
            expect(threadOfSession2).toBe(thread.id);
            // The new farm has heard nothing yet: what was said before is in the room's history.
            expect((yield* g.chat.history(thread.id)).some((m) => m.id === said.id)).toBe(true);
          }),
        config,
      );
    });
  });

  it.live("regression: a committed message without a route receipt is routed after restart", () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    let message: T.ChatMessage;
    return Effect.gen(function* () {
      yield* run(
        (f, x) =>
          Effect.gen(function* () {
            x.holds = false;
            thread = yield* hireAndRun(f, x, "w15", "write route", "chat-route");
            message = (yield* f.chat.say("recover this input", thread.id, "route-gap")).message;
            yield* until(async () => (await f.deliveryOf("w15", message.id))?.state === "consumed", "the first route");
            yield* f.sql`delete from mailbox_delivery where envelope_id = ${message.id}`;
            yield* f.sql`update mailbox_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${message.id}`;
          }),
        config,
      );
      yield* run(
        (_f, x) =>
          Effect.gen(function* () {
            x.holds = false;
            yield* until(() => x.runsOf("w15").some((input) => input.includes("recover this input")), "the recovered route");
          }),
        config,
      );
    });
  });

  it.live("regression: a message that cannot be routed is tried once at startup, not again and again", () => {
    const config = { ...testConfig(), db: "" };
    let thread: T.Channel;
    return Effect.gen(function* () {
      yield* run(
        (f, x) =>
          Effect.gen(function* () {
            x.holds = false;
            thread = yield* hireAndRun(f, x, "w16", "write route", "chat-stuck");
            const stuck = (yield* f.chat.say("this one cannot be routed", thread.id, "stuck")).message;
            yield* until(async () => (await f.deliveryOf("w16", stuck.id))?.state === "consumed", "the first route");
            // A receipt that no longer reads: routing it fails every time it is tried.
            yield* f.sql`update mailbox_trigger set routed_at = null, routing_scope = null, routing_position = null, trigger_json = 'not json' where id = ${stuck.id}`;
          }),
        config,
      );
      // The farm comes up past the row it cannot route, and takes new words.
      yield* run(
        (f, x) =>
          Effect.gen(function* () {
            x.holds = false;
            yield* f.chat.say("after the stuck one", thread.id, "after");
            yield* until(() => x.runsOf("w16").some((input) => input.includes("after the stuck one")), "a message after the stuck one");
          }),
        config,
      ).pipe(Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.die(new Error("the farm did not come up past the stuck row")) }));
    });
  });

  it("an undeclared report's summary does not parse prose markers", () => {
    expect(summaryOf("先看看。\n\n**结论：** 改好了，测试通过。\n\n备注：无")).toContain("备注：无");
    expect(summaryOf("做了一些事\n\n- 结论：好了")).toBe("做了一些事\n\n- 结论：好了");
    expect(summaryOf("第一段\n\n第二段")).toBe("第一段\n\n第二段");
    expect(head("😀abc", 1)).toBe("");
  });

  it.live("a valid JSON message meta with the wrong shape degrades to none", () =>
    run((f) =>
      Effect.gen(function* () {
        const { message } = yield* f.chat.say("带元数据", undefined, "");
        yield* Effect.orDie(qm.updateMessageMeta({ meta: `{"mentions":{},"spent":{"tokens":1e999}}`, id: message.id }));
        const saved = (yield* f.chat.history(f.chat.defaultChannel())).find((m) => m.id === message.id)!;
        expect(saved.text).toBe("带元数据");
        expect([saved.mentions, saved.spent, saved.run]).toEqual([[], undefined, undefined]);
      }),
    ),
  );

  it.live("a message keeps the run that made it", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "complete", "run-first", defaultOrchestrator);
        yield* f.chat.orchestratorSays(general, "unlinked", "", defaultOrchestrator);
        const saved = yield* f.chat.history(general);
        expect(saved.map((m) => [m.text, m.run])).toEqual([
          ["complete", "run-first"],
          ["unlinked", undefined],
        ]);
        yield* hireAndRun(f, x, "run-helper", "test run metadata", "chat-k");
        yield* f.core.apply({
          type: "sessionReported",
          questions: [],
          checks: [],
          id: sessionId("run-helper"),
          outcome: "completed",
          summary: "done",
          run: "finished-run",
          runs: 2,
        });
        yield* until(
          () =>
            f
              .messagesOf(f.chat.defaultChannel())
              .concat(...(f.core.state().chat?.channels ?? []).map((c) => f.messagesOf(c.id)))
              .some((m) => m.from === "run-helper" && m.run === "finished-run"),
          "the report carries its run",
        );
      }),
    ),
  );

  it.live("a room catches a follower up past its number, then tells it what is said there", () =>
    run((f) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        for (const text of ["一", "二", "三"]) yield* f.chat.say(text, undefined, "");
        const one = (yield* f.chat.history(general)).find((m) => m.text === "一")!;
        const following = yield* Effect.forkChild(Stream.runCollect(Stream.take(f.chat.follow(general, one.revision), 3)));
        // What is said elsewhere is not this room's.
        const elsewhere = (yield* f.chat.openChannel("别处", "", "")).id;
        yield* f.chat.orchestratorSays(elsewhere, "别处的话", "", defaultOrchestrator);
        yield* until(() => f.messagesOf(elsewhere).length > 0, "said elsewhere");
        yield* f.chat.say("四", undefined, "send-4");
        const got = yield* Fiber.join(following);
        expect(got.map((e) => (e._tag === "Message" ? [e.message.number, e.message.text] : e._tag))).toEqual([
          [2, "二"],
          [3, "三"],
          [4, "四"],
        ]);
        // The owner's own line carries its key: a page knows the line it sent.
        expect(got.map((e) => (e._tag === "Message" ? e.message.sendKey : undefined))).toEqual([undefined, undefined, "send-4"]);
      }),
    ),
  );

  it.live("a message changes: replies, edits, deletions, reactions and pins, each caught up by revision", () => {
    const config = testConfig();
    return run(
      (f) =>
        Effect.gen(function* () {
          const general = f.chat.defaultChannel();
          const first = (yield* f.chat.say("先这样", undefined, "")).message;
          expect((yield* f.chat.history(general))[0]!.reactions).toEqual([]);
          const reply = (yield* f.chat.say("补一句", undefined, "", { replyTo: first.number })).message;
          expect(reply.replyTo).toBe(first.number);
          const saidFailure = yield* Effect.flip(f.chat.say("没有这条", undefined, "", { replyTo: 99 }));
          expect(saidFailure).toMatchObject({ _tag: "Refused" });
          const since = (yield* f.chat.history(general)).at(-1)!.revision;

          const edited = yield* f.chat.edit(first.id, "改成这样");
          expect([edited.text, edited.edited !== undefined, edited.revision > since]).toEqual(["改成这样", true, true]);
          const theirs = (yield* f.chat.speak(defaultOrchestrator, "我来看看", { anyway: true, confirm: true })).message!;
          const editedFailure = yield* Effect.flip(f.chat.edit(theirs.id, "不是你的"));
          expect(editedFailure).toMatchObject({ _tag: "Refused" });
          const liked = yield* f.chat.react(theirs.id, "owner", "👍", true);
          expect(liked.reactions).toEqual([{ emoji: "👍", by: ["owner"] }]);
          // A set repeated (a retry) is no change: the same revision, the reaction once.
          const again = yield* f.chat.react(theirs.id, "owner", "👍", true);
          expect([again.reactions, again.revision]).toEqual([liked.reactions, liked.revision]);
          const taken = yield* f.chat.react(theirs.id, "owner", "👍", false);
          expect(taken.reactions).toEqual([]);
          expect((yield* f.chat.react(theirs.id, "owner", "👍", false)).revision).toBe(taken.revision);
          const pinned = yield* f.chat.pin(reply.id, true);
          expect(pinned.pinned).toBeDefined();
          expect((yield* f.chat.pin(reply.id, true)).revision).toBe(pinned.revision);
          expect((yield* f.chat.pins(general)).map((m) => m.id)).toEqual([reply.id]);
          expect((yield* f.chat.previewRemove(theirs.id)).does[0]).toContain(`第 ${theirs.number} 条`);
          yield* f.chat.remove(theirs.id);
          const removedFailure = yield* Effect.flip(f.chat.remove(theirs.id));
          expect(removedFailure).toMatchObject({ _tag: "Refused" });

          const caught = yield* Stream.runCollect(Stream.take(f.chat.follow(general, since), 3));
          expect(caught.map((e) => (e._tag === "Message" ? [e.message.number, e.message.text, e.message.deleted !== undefined] : e._tag))).toEqual([
            [first.number, "改成这样", false],
            [reply.number, "补一句", false],
            [theirs.number, "", true],
          ]);
          const hits = yield* f.chat.search("补一");
          expect(hits.map((h) => [h.message.id, h.address])).toEqual([[reply.id, "#general"]]);
          const thread = yield* f.chat.threadUnder(reply.id);
          expect(f.channel(thread)?.root).toBe(reply.id);
          const threadUnder2 = yield* f.chat.threadUnder(reply.id);
          expect(threadUnder2).toBe(thread);

          const file = yield* f.chat.attach({ name: "截图.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") });
          expect(file).toMatchObject({ name: "截图.png", type: "image/png", size: 9 });
          expect((yield* f.chat.attach({ name: "again.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") })).id).toBe(file.id);
          const shown = (yield* f.chat.say("", undefined, "", { attachments: [file.id] })).message;
          expect(shown.attachments).toEqual([file]);
          const kept = yield* f.chat.attachment(file.id);
          expect(readFileSync(kept!.path, "utf8")).toBe("png bytes");
          expect((yield* f.chat.read(defaultOrchestrator, { target: "#general", limit: 1 })).messages[0]!.attachments).toEqual([
            { name: "截图.png", path: kept!.path },
          ]);
          const saidFailure2 = yield* Effect.flip(f.chat.say("", undefined, "", { attachments: ["nope"] }));
          expect(saidFailure2).toMatchObject({ _tag: "Missing" });
        }),
      config,
    );
  });

  it.live("regression: an attachment that cannot be kept is refused with the file system's own words", () => {
    const config = testConfig();
    // A file where the attachments folder should be: making the folder fails, already existing.
    writeFileSync(join(config.home, "attachments"), "");
    return run(
      (f) =>
        Effect.gen(function* () {
          const refusal = yield* Effect.flip(f.chat.attach({ name: "a.txt", type: "", data: Buffer.from("x").toString("base64") }));
          expect(refusal).toMatchObject({ _tag: "Refused", reason: expect.stringContaining("AlreadyExists") });
        }),
      config,
    );
  });

  it.live("the farm's log hears every report: the newest ones first, then each as it is written", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w21", "写 hello", "chat-k");
        const first = yield* Stream.runCollect(Stream.take(f.chat.reports(), 1));
        const was = first[0]!._tag === "Message" ? first[0]!.message : undefined;
        expect([was?.kind, was?.from]).toEqual(["report", "w21"]);
        const next = yield* Effect.forkChild(Stream.runCollect(Stream.take(f.chat.reports(was!.id), 1)));
        yield* hireAndRun(f, x, "w22", "写 world", "chat-k");
        const got = yield* Fiber.join(next);
        expect(got.map((e) => e._tag === "Message" && e.message.from)).toEqual(["w22"]);
      }),
    ),
  );

  it.live("a follower too far behind is told to reload the room", () =>
    run((f) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        for (let i = 0; i <= catchUpMax; i++) yield* f.chat.orchestratorSays(general, `第 ${i} 句`, "", defaultOrchestrator);
        const first = yield* Stream.runCollect(Stream.take(f.chat.follow(general, 0), 1));
        expect(first).toEqual([{ _tag: "Reset" }]);
        const near = yield* Stream.runCollect(Stream.take(f.chat.follow(general, 1), 1));
        expect(near.map((e) => e._tag === "Message" && e.message.number)).toEqual([2]);
        const drainOutcomeFailure = yield* Effect.flip(Stream.runDrain(f.chat.follow("no-such-room", 0)));
        expect(drainOutcomeFailure).toMatchObject({ _tag: "Refused" });
      }),
    ),
  );

  it.live("a send key writes once", () =>
    run((f) =>
      Effect.gen(function* () {
        const first = yield* f.chat.say("早", undefined, "k1");
        const second = yield* f.chat.say("早", undefined, "k1");
        expect([first.again, second.again, second.message.id, second.message.number]).toEqual([false, true, first.message.id, first.message.number]);
        expect((yield* f.chat.say("早", undefined, "k2")).again).toBe(false);
        for (let i = 0; i < 2; i++) expect((yield* f.chat.say("晚", undefined, "")).again).toBe(false);
        const saidFailure = yield* Effect.flip(f.chat.say("早", undefined, "k".repeat(65)));
        expect(saidFailure).toMatchObject({ reason: "sendKey 太长" });
        for (let i = 0; i < 2; i++) yield* f.chat.spoken("owner", "电话里说的", "k3");
        const owners = () => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.from === "owner");
        yield* until(() => owners().length >= 5, "the owner's lines heard");
        const said: Record<string, number> = {};
        for (const m of owners()) said[m.text] = (said[m.text] ?? 0) + 1;
        expect(said).toEqual({ 早: 2, 晚: 2, 电话里说的: 1 });
        const deliveries2 = yield* Effect.promise(() => f.deliveries(defaultOrchestrator));
        expect(deliveries2).toHaveLength(4);
      }),
    ),
  );

  const trigger = (sql: SqlClient.SqlClient, name: string, on: string, when = "") => refuse(sql, name, on, when);
  const drop = (sql: SqlClient.SqlClient, name: string, _table: string) => allow(sql, name);

  it.live("regression: channel fanout rolls back all recipients and replays the committed message once", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hire(f, x, "w1", "first", "demo");
        yield* hire(f, x, "w2", "second", "demo");
        yield* trigger(f.sql, "fail_second_recipient", "before insert on mailbox_delivery", "new.session_id = 'w2'");
        expect((yield* Effect.exit(f.chat.say("@w1 @w2 atomic fanout", undefined, "fanout-key")))._tag).toBe("Failure");
        const [message] = yield* f.sql<{ id: string }>`select id from channel_message where send_key = 'fanout-key'`;
        expect(message).toBeDefined();
        const id = message!.id;
        const rows = yield* f.sql`select session_id from mailbox_delivery where envelope_id = ${id}`;
        expect(rows).toEqual([]);
        const registered2 = yield* f.mailbox.isRouted(id);
        expect(registered2).toBe(false);
        expect(f.mailbox.deliveriesOf("w1").some((row) => row.envelope_id === id)).toBe(false);
        yield* drop(f.sql, "fail_second_recipient", "mailbox_delivery");
        yield* f.chat.start;
        yield* f.chat.start;
        const rows2 = yield* f.sql`select session_id from mailbox_delivery where envelope_id = ${id} order by session_id`;
        expect(rows2).toEqual([{ session_id: "w1" }, { session_id: "w2" }]);
        const registered3 = yield* f.mailbox.isRouted(id);
        expect(registered3).toBe(true);
      }),
    ),
  );

  it.live("a read receipt is written whole or not at all", () =>
    run((f) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "hello", "", defaultOrchestrator);
        const [message] = yield* f.chat.history(general);
        yield* trigger(f.sql, "fail_receipt", "before insert on channel_read_cursor");
        expect((yield* Effect.exit(f.chat.markRead(general, message!.number)))._tag).toBe("Failure");
        const rows = yield* f.sql`select read_number from channel_read_cursor where participant_id = 'owner' and channel_id = ${general}`.pipe(Effect.orDie);
        expect(rows).toEqual([]);
        // Nor is it read in what the chat shows next: what it kept in memory is read again from the database.
        yield* f.chat.notice(general, "动静", "test");
        expect(f.channel(general)?.read).toBeUndefined();
        yield* drop(f.sql, "fail_receipt", "channel_read_cursor");
        yield* f.chat.markRead(general, message!.number);
        const rows2 = yield* f.sql`select read_number from channel_read_cursor where participant_id = 'owner' and channel_id = ${general}`.pipe(Effect.orDie);
        expect(rows2).toEqual([{ read_number: message!.number }]);
        expect(f.channel(general)?.read).toBe(message!.number);
      }),
    ),
  );

  it.live("a dispatch whose thread cannot take its member leaves no dispatch, and a second try writes one", () => {
    const log = heard();
    return run(
      (f) =>
        Effect.gen(function* () {
          yield* trigger(f.sql, "fail_owner", "before insert on channel_member", "new.reason = 'owner'");
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
          yield* keepSession(f, first);
          yield* f.core.apply({
            type: "sessionChanged",
            session: first,
          });
          yield* waitFor(
            Effect.sync(() => log.count("fail_owner")),
            (n) => n > 0,
            "the dispatch tried and refused",
          );
          const history2 = yield* f.chat.history(f.chat.defaultChannel());
          expect(history2).toEqual([]);
          yield* drop(f.sql, "fail_owner", "channel_member");
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
          yield* keepSession(f, second);
          yield* f.core.apply({
            type: "sessionChanged",
            session: second,
          });
          yield* until(() => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.kind === "dispatch").length === 2, "both dispatched");
          const thread = (yield* f.chat.threadOfSession("w1"))!;
          expect(
            (yield* f.sql`select participant_id from channel_member where channel_id = ${thread}`.pipe(Effect.orDie)).map((r) => r.participant_id),
          ).toEqual(["w1"]);
        }),
      undefined,
      log.layer,
    );
  });
});

it.effect("regression: mailbox routing reads the current channel manager through threads and direct conversations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`insert into channel_participant (id, kind, name, joined_at) values ('manager', 'orchestrator', 'manager', 0), ('first', 'orchestrator', 'first', 0), ('second', 'orchestrator', 'second', 0)`;
    yield* sql`insert into channel (id, type, name, created_at) values ('room', 'channel', 'room', 0)`;
    yield* addMember({ channel_id: "room", participant_id: "first", reason: "manual", from_number: 0 });
    yield* sql`insert into channel_message (id, channel_id, number, sender_id, kind, body, created_at, revision)
      values ('root', 'room', 1, 'manager', 'chat', '', 0, 1)`;
    yield* sql`insert into channel (id, type, root_id, parent_id, created_at) values ('thread', 'thread', 'root', 'room', 0)`;
    yield* sql`insert into channel (id, type, peer_id, created_at) values ('direct', 'direct', 'manager', 0)`;
    // Every agent named here is taken for an orchestrator: what is under test is which place's members are read.
    const orchestratorHere = Effect.fn(function* (id: string) {
      const top = yield* topPlace({ id });
      const rows = yield* membersOf({ channel_id: top.id });
      return orchestratorIn({ top, members: Arr.map(rows, (m) => m.participant_id), isOrchestrator: () => true });
    });
    const before = yield* orchestratorHere("thread");
    expect(before).toBe("first");
    yield* removeMember({ channel_id: "room", participant_id: "first", at: 1 });
    yield* addMember({ channel_id: "room", participant_id: "second", reason: "manual", from_number: 0 });
    const after = yield* orchestratorHere("thread");
    const direct = yield* orchestratorHere("direct");
    expect([after, direct]).toEqual(["second", "manager"]);
  }).pipe(Effect.provide(testDatabase())),
);
