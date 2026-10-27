import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { type ChatMessage, type Channel, orchestratorAgent, type Session } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { channelOf, defaultOf } from "./state.ts";
import { Said, said } from "../testing/said.ts";
import { head } from "../base/text.ts";
import { wakeBreaker } from "./rules.ts";
import { Effect, Fiber, Layer, PubSub, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { type Config, Settings } from "../base/config.ts";
import { Database, DbLayer } from "../base/db.ts";
import { Core, layer as coreLayer } from "../core/core.ts";
import { newsOf } from "../session/session.ts";
import { sessionOnIssue } from "../session/state.ts";
import { layer as projection } from "../projection/projection.ts";
import { summaryOf } from "../session/rules.ts";
import { testConfig } from "../testing/layers.ts";
import { catchUpMax, Channels, type Delivered, type LaunchActivity, layer as channelLayer, type OrchestratorNews } from "./chat.ts";
import { until, waitFor } from "../testing/until.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import { sessionId } from "@vibevalley/protocol/schema";

/** Sessions played: a turn takes its input, says it got it and reports; 「慢慢做」 is held until release (unless holds is
 * off), 「必败」 fails. */
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
  launches!: PubSub.PubSub<LaunchActivity>;

  runsOf = (id: string) => [...(this.inputs.get(id) ?? [])];
  steersOf = (id: string) => [...(this.steers.get(id) ?? [])];
  private publish = (a: LaunchActivity) => PubSub.publishUnsafe(this.launches, a);
  private apply = (...f: Parameters<Core["Service"]["apply"]>) => Effect.runSync(this.core.apply(...f));

  deliver = (id: string, text: string): Delivered => {
    if (!this.core.session(id)) return { kind: "refused", reason: "不在地里" };
    const launch = this.running.get(id);
    if (launch) {
      this.steers.set(id, [...this.steersOf(id), text]);
      return { kind: "steered", launch };
    }
    const fresh = `${id}-${++this.n}`;
    this.running.set(id, fresh);
    this.inputs.set(id, [...this.runsOf(id), text]);
    this.apply({ type: "run", id: sessionId(id) });
    void this.run(id, fresh, text);
    return { kind: "run", launch: fresh, woke: true };
  };

  private async run(id: string, launch: string, input: string) {
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
    if (input.includes("必败")) {
      this.running.delete(id);
      this.apply({ type: "report", id: sessionId(id), outcome: "failed", summary: "provider said no", runs });
      this.publish({ kind: "ended", id, launch, outcome: "failed", spoke: false });
      return;
    }
    const line = input.split("\n").find((l) => l.startsWith("[target=")) ?? head(input, 20);
    this.last.set(id, "结论：收到了（" + line + "）");
    this.publish({ kind: "spoke", id, launch });
    this.running.delete(id);
    this.apply({ type: "report", id: sessionId(id), outcome: "completed", summary: "收到了", runs });
    this.publish({ kind: "ended", id, launch, outcome: "completed", spoke: true });
  }
}

/** The fake sessions as the channels' helpers, registered the way Agent Sessions registers the real ones. */
const fakeHelpers = (x: FakeSessions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      x.core = yield* Core;
      const chat = yield* Channels;
      x.launches = yield* PubSub.unbounded<LaunchActivity>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          x.stopped = true;
          x.release();
        }),
      );
      chat.useHelpers({
        present: (id) => x.core.session(id) !== undefined,
        deliver: (id, text) => Effect.sync(() => x.deliver(id, text)),
        currentRun: () => undefined,
        report: (id) => summaryOf(x.last.get(id) ?? ""),
        onIssue: (issue) => sessionOnIssue(x.core.state(), issue)?.id,
        sessionOf: (id) => x.core.session(id),
        presentSessions: () => x.core.state().sessions,
      });
      yield* Effect.forkScoped(Stream.runForEach(Stream.fromSubscription(yield* PubSub.subscribe(x.launches)), chat.activity));
      // As the sessions tell the chat of their own facts.
      const [, moves] = yield* x.core.transitions;
      yield* Effect.forkScoped(
        Stream.runForEach(moves, ({ fact, after }) => {
          const n = newsOf(fact, after);
          return n ? chat.sessionNews(n) : Effect.void;
        }),
      );
      yield* chat.helpersBack;
    }),
  );

const world = (x: FakeSessions, config: Config = testConfig()) => {
  const c: Config = { ...config, chat: { noticeBatchMs: 300, retryWakeMs: 100 } };
  return fakeHelpers(x).pipe(
    Layer.provideMerge(channelLayer),
    Layer.provideMerge(said),
    Layer.provideMerge(coreLayer.pipe(Layer.provide(projection))),
    Layer.provideMerge(DbLayer),
    Layer.provideMerge(Database),
    Layer.provideMerge(Layer.succeed(Settings, c)),
  );
};

/** The services of a test, and its helpers. */
const farm = Effect.gen(function* () {
  const core = yield* Core;
  const chat = yield* Channels;
  const sql = yield* SqlClient.SqlClient;
  const messagesOf = (yield* Said).in;
  const channel = (id: string | undefined) => (id ? channelOf(core.state().chat, id) : undefined);
  const deliveries = (recipient: string) =>
    Effect.runPromise(
      sql<{
        message_id: string;
        reason: string;
        wakes: boolean;
        held_by: string;
        state: string;
      }>`select message_id, reason, wakes, coalesce(held_by, '') as held_by, state from channel_delivery where recipient_id = ${recipient} order by message_id`,
    );
  const deliveryOf = async (recipient: string, message: string) => (await deliveries(recipient)).find((d) => d.message_id === message);
  return { core, chat, sql, messagesOf, channel, deliveries, deliveryOf };
});

type Farm = Effect.Success<typeof farm>;

const hire = (f: Farm, x: FakeSessions, id: string, task: string, project: string, channel?: string, issue?: string) =>
  Effect.gen(function* () {
    yield* f.core.apply({
      type: "hired",
      session: {
        id,
        name: "帮工" + id,
        agent: "lab",
        runtime: "pi",
        brief: task,
        project,
        hiredAt: Date.now(),
        runs: 0,
        phase: { _tag: "resting" },
        ...(channel ? { channel } : {}),
        ...(issue ? { issue } : {}),
      } as Session,
    });
    let thread: Channel | undefined;
    yield* until(async () => (thread = f.channel(await Effect.runPromise(f.chat.jobThread(id)))) !== undefined, "a job thread");
    return thread!;
  });

/** Hired, and its first turn reported in its thread. */
const hireAndRun = (f: Farm, x: FakeSessions, id: string, task: string, project: string, channel?: string) =>
  Effect.gen(function* () {
    const thread = yield* hire(f, x, id, task, project, channel);
    expect(x.deliver(id, task).kind).toBe("run");
    yield* until(() => f.messagesOf(thread.id).some((m) => m.kind === "report" && m.from === id), "its first report");
    return thread;
  });

const news = (f: Farm) =>
  Effect.gen(function* () {
    const heard: OrchestratorNews[] = [];
    yield* Effect.forkScoped(Stream.runForEach(yield* f.chat.forOrchestrator, (n) => Effect.sync(() => heard.push(n))));
    return {
      of: (message: string) =>
        Effect.gen(function* () {
          yield* until(() => heard.some((n) => n.messages.some((m) => m.id === message)), `the orchestrator hearing of ${message}`);
          return heard.find((n) => n.messages.some((m) => m.id === message))!;
        }),
    };
  });

const run = <A, E>(body: (f: Farm, x: FakeSessions) => Effect.Effect<A, E, Core | Channels | SqlClient.SqlClient | Scope.Scope>, config?: Config) => {
  const x = new FakeSessions();
  return Effect.flatMap(farm, (f) => body(f, x)).pipe(Effect.scoped, Effect.provide(world(x, config)));
};

describe("the chat", () => {
  it.live("a job opens a thread under its dispatch", () =>
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
        expect(yield* f.chat.jobThread("w1")).toBe(thread.id);
      }),
    ),
  );

  it.live("a session sent for no issue has a talk thread", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const talk = yield* hireAndRun(f, x, "w1", "写 hello", "chat-t");
        expect([talk.subjectKind, talk.subjectId]).toEqual(["talk", "w1"]);
        const job = yield* hire(f, x, "w2", "写 world", "chat-t", undefined, "i1");
        expect([job.subjectKind, job.subjectId, job.id !== talk.id]).toEqual(["issue", "i1", true]);
        yield* f.chat.say("把输出改成中文", talk.id, "");
        yield* until(() => x.runsOf("w1").length >= 2, "a second turn");
      }),
    ),
  );

  it.live("the owner's words in a job thread wake its session", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w2", "写 hello", "chat-b");
        const { message: said } = yield* f.chat.say("把输出改成中文", thread.id, "");
        yield* until(() => x.runsOf("w2").length >= 2, "a second turn");
        expect(x.runsOf("w2")[1]).toContain(`[target=#general:${thread.rootNumber} msg=${said.number} from=主人] 把输出改成中文`);
        yield* until(async () => (await f.deliveryOf("w2", said.id))?.state === "seen", "seen");
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
        expect(yield* Effect.promise(() => f.deliveryOf("w3", said.id))).toMatchObject({ reason: "channel", wakes: false });
        expect(yield* Effect.promise(() => f.deliveryOf(orchestratorAgent, said.id))).toMatchObject({ state: "seen" });
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
            expect([direct?.peer, direct?.title, more.length]).toEqual([orchestratorAgent, "管家", 0]);
            const heard = yield* news(f);
            const before = x.runsOf("w3").length;
            const { message: said } = yield* f.chat.say("@w3 你先别动，我们单独说", direct!.id, "");
            const n = yield* heard.of(said.id);
            expect([n.channel, n.type, n.target]).toEqual([direct!.id, "direct", "@owner"]);
            expect(yield* Effect.promise(() => f.deliveryOf(orchestratorAgent, said.id))).toMatchObject({ reason: "direct", wakes: true });
            expect(yield* Effect.promise(() => f.deliveryOf("w3", said.id))).toBeUndefined();
            expect(x.runsOf("w3")).toHaveLength(before);
            expect(f.messagesOf(direct!.id).at(-1)?.mentions).toBeUndefined();
            yield* f.chat.orchestratorSays(direct!.id, "好，说吧", "");
            yield* until(() => (f.channel(direct!.id)?.unread ?? 0) === 1, "the answer unread");
            expect((yield* f.chat.read(orchestratorAgent, { target: "@主人" })).messages.map((m) => m.text)).toEqual(["@w3 你先别动，我们单独说", "好，说吧"]);
            expect(yield* f.chat.addressOf(direct!.id)).toEqual({ direct: true, target: "@owner" });
            expect((yield* f.chat.topOf(direct!.id)).id).toBe(f.chat.defaultChannel());
            expect(yield* Effect.flip(f.chat.read("w3", { target: "@owner" }))).toMatchObject({ reason: expect.stringContaining("没有私聊") });
            expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["general"]);
            expect(yield* Effect.flip(f.chat.makeDefault(direct!.id))).toMatchObject({ _tag: "Refused" });
          }),
        config,
      );
      yield* run((g) => Effect.sync(() => expect(directs(g)).toHaveLength(1)), config);
    });
  });

  it.live("channels", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const channel = yield* f.chat.openChannel("#clock-in", "打卡页", "chat-ch");
        expect(channel).toMatchObject({ name: "clock-in", project: "chat-ch", description: "打卡页" });
        expect(yield* Effect.flip(f.chat.openChannel("clock-in", "", ""))).toMatchObject({ reason: expect.stringContaining("已经有") });
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
        expect(yield* Effect.promise(() => f.deliveryOf("w4", said.id))).toMatchObject({ reason: "channel" });
        expect(yield* Effect.promise(() => f.deliveryOf("w5", said.id))).toBeUndefined();
        expect((yield* f.chat.read("w4", { target: "#clock-in" })).target).toBe("#clock-in");
        expect((yield* f.chat.speak("w4", "今天能好", { target: "#clock-in", anyway: true, confirm: true })).kind).toBe("sent");
        expect(yield* Effect.flip(f.chat.read("w4", { target: "#nowhere" }))).toMatchObject({
          _tag: "Missing",
          what: expect.stringContaining("没有叫 #nowhere 的频道"),
        });
        expect((yield* f.chat.topOf(thread.id)).name).toBe("clock-in");
        yield* f.chat.updateChannel(channel.id, undefined, "");
        expect(yield* f.chat.channelByName("clock-in")).toMatchObject({ project: "", description: "打卡页" });
        expect(channelOf(f.core.state().chat, channel.id)?.project).toBeUndefined();
        const general = f.chat.defaultChannel();
        yield* f.chat.makeDefault(channel.id);
        expect([f.chat.defaultChannel(), defaultOf(f.core.state().chat)?.id, channelOf(f.core.state().chat, general)?.default]).toEqual([
          channel.id,
          channel.id,
          undefined,
        ]);
        expect((yield* f.chat.channels()).map((c) => c.name)).toEqual(["clock-in", "general"]);
        expect((yield* f.chat.say("没写频道", undefined, "")).message.channel).toBe(channel.id);
      }),
    ),
  );

  it.live("a busy session gets one notice for a burst", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hire(f, x, "w6", "慢慢做一个大活", "chat-d");
        x.deliver("w6", "慢慢做一个大活");
        expect(isBusy(f.core.session("w6")!)).toBe(true);
        yield* f.chat.say("补充：顺便写测试", thread.id, "");
        yield* f.chat.say("还有：写 README", thread.id, "");
        // Still busy when the burst's one notice comes in; then the turn may finish.
        yield* until(() => x.steersOf("w6").some((s) => s.startsWith("[群聊提示]")), "the burst's notice");
        x.release();
        yield* until(() => x.runsOf("w6").length >= 2, "a second turn");
        const notices = x.steersOf("w6").filter((s) => s.startsWith("[群聊提示]"));
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("2 条");
        expect(notices[0]).not.toContain("写测试");
        expect(x.runsOf("w6")[1]).toContain("补充：顺便写测试");
        expect(x.runsOf("w6")[1]).toContain("还有：写 README");
      }),
    ),
  );

  it.live("helpers calling each other stop at the hop limit", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w7", "写 hello", "chat-e");
        // The orchestrator is never cooled down, so only the hop limit holds.
        for (let i = 1; i <= 5; i++) expect((yield* f.chat.speak("w7", `@管家 第 ${i} 次问`, { anyway: true })).kind).toBe("sent");
        const held = (yield* Effect.promise(() => f.deliveries(orchestratorAgent))).filter((d) => d.reason === "mention").map((d) => d.held_by);
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
        expect(yield* Effect.flip(f.chat.speak("w10", "hi", { target: "#general:999999" }))).toMatchObject({
          reason: expect.stringContaining("没有 999999 这条消息"),
        });
        const { message: sq } = yield* f.chat.say("大家早", f.chat.defaultChannel(), "");
        const talk = yield* f.chat.speak("w10", "早", { target: `#general:${sq.number}`, anyway: true });
        expect([talk.kind, talk.target]).toEqual(["sent", `#general:${sq.number}`]);
        const under = f.core.state().chat?.channels?.find((c) => c.root === sq.id);
        expect(under?.subjectKind).toBe("talk");
      }),
    ),
  );

  it.live("the orchestrator's words are written once, whole, and delivered", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w11", "写 hello", "chat-k");
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "  ", "");
        const ours = () => f.messagesOf(general).filter((m) => m.from === orchestratorAgent && m.kind === "chat");
        expect(ours()).toEqual([]);
        yield* f.chat.orchestratorSays(general, "好的，我叫 @w11 去看看", "");
        expect(ours().map((m) => [m.text, m.mentions])).toEqual([["好的，我叫 @w11 去看看", ["w11"]]]);
        yield* until(() => x.runsOf("w11").length >= 2 && x.runsOf("w11")[1]!.includes("我叫 @w11 去看看"), "w11 woken");
        yield* f.chat.notice(general, "定时到了", "recurrence");
        const last = f.messagesOf(general).at(-1)!;
        expect([last.kind, last.from]).toEqual(["notice", "system"]);
        expect((yield* Effect.promise(() => f.deliveries("w11"))).at(-1)?.message_id).not.toBe(last.id);
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
        const page = yield* f.chat.read("owner", { target: "#general", before: seqs[4], limit: 2 });
        expect([page.messages.map((m) => m.number), page.older]).toEqual([[seqs[2], seqs[3]], true]);
        const older = yield* f.chat.read("owner", { target: "#general", before: page.messages[0]!.number, limit: 2 });
        expect([older.messages.map((m) => m.number), older.older]).toEqual([[seqs[0], seqs[1]], false]);
        yield* f.chat.markRead(general, seqs[1]!);
        expect((yield* Effect.flip(f.chat.markRead("nope", 1)))._tag).toBe("Missing");
        expect(defaultOf(f.core.state().chat)?.read).toBe(seqs[4]);
        expect((yield* Effect.flip(f.chat.say("  ", undefined, "")))._tag).toBe("Refused");
        expect(yield* f.chat.orchestratorDigest()).toEqual([]);
      }),
    ),
  );

  it.live("the inbox and the orchestrator's digest", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const thread = yield* hireAndRun(f, x, "w12", "写 hello", "chat-l");
        const digest = yield* f.chat.orchestratorDigest();
        expect(digest.map((d) => [d.from, d.target])).toEqual([["w12", `#general:${thread.rootNumber}`]]);
        expect(yield* f.chat.orchestratorDigest()).toHaveLength(1);
        // Taken as input by the orchestrator's run, as its execution says once it took it.
        yield* f.chat.consumed({ session: orchestratorAgent, messages: [digest[0]!.id] });
        expect(yield* f.chat.orchestratorDigest()).toEqual([]);
        yield* f.chat.say("大家看一下", f.chat.defaultChannel(), "");
        const inbox = yield* f.chat.inbox("w12");
        expect(inbox).toEqual([{ target: "#general", unread: 2, mentionsYou: true, latest: "主人" }]);
        yield* f.chat.read("w12", { target: "#general" });
        expect(yield* f.chat.inbox("w12")).toEqual([]);
      }),
    ),
  );

  it.live("a session that leaves has what was for it dropped", () =>
    run((f, x) =>
      Effect.gen(function* () {
        yield* hireAndRun(f, x, "w13", "写 hello", "chat-m");
        yield* until(() => !isBusy(f.core.session("w13")!), "resting");
        yield* f.chat.say("随便说说", f.chat.defaultChannel(), "");
        yield* f.core.apply({ type: "left", id: sessionId("w13") });
        yield* until(async () => (await f.deliveries("w13")).at(-1)?.state === "dropped", "dropped");
        const left = yield* f.sql<{ left_at: number | null }>`select left_at from channel_participant where id = 'w13'`;
        expect(left[0]?.left_at).not.toBeNull();
      }),
    ),
  );

  it.live("after a restart what was handed is given again", () => {
    const config = { ...testConfig(), db: "" };
    let thread: Channel;
    let said: ChatMessage;
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
            yield* g.core.apply({ type: "report", id: sessionId("w14"), outcome: "interrupted", summary: "重启了", runs: 1 });
            yield* until(async () => (await g.deliveryOf("w14", said.id))?.state === "seen", "seen after the restart");
            expect(y.runsOf("w14").at(-1)).toContain("再加一个文件");
            expect(yield* g.chat.jobThread("w14")).toBe(thread.id);
            // The new farm has heard nothing yet: what was said before is in the room's history.
            expect((yield* g.chat.history(thread.id)).some((m) => m.id === said.id)).toBe(true);
          }),
        config,
      );
    });
  });

  it("a report's summary is its verdict", () => {
    expect(summaryOf("先看看。\n\n**结论：** 改好了，测试通过。\n\n备注：无")).toBe("改好了，测试通过。");
    expect(summaryOf("做了一些事\n\n- 结论：好了")).toBe("好了");
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
        expect([saved.mentions, saved.spent, saved.run]).toEqual([undefined, undefined, undefined]);
      }),
    ),
  );

  it.live("a message keeps the run that made it", () =>
    run((f, x) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "complete", "run-first");
        yield* f.chat.orchestratorSays(general, "unlinked", "");
        const saved = yield* f.chat.history(general);
        expect(saved.map((m) => [m.text, m.run])).toEqual([
          ["complete", "run-first"],
          ["unlinked", undefined],
        ]);
        yield* hireAndRun(f, x, "run-helper", "test run metadata", "chat-k");
        yield* f.core.apply({ type: "report", id: sessionId("run-helper"), outcome: "completed", summary: "done", run: "finished-run", runs: 2 });
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
        // Caught up by revision: from where 一 now stands (the orchestrator's 👀 on it is a change too).
        const one = (yield* f.chat.history(general)).find((m) => m.text === "一")!;
        const following = yield* Effect.forkChild(Stream.runCollect(Stream.take(f.chat.follow(general, one.revision), 3)));
        // What is said elsewhere is not this room's.
        const elsewhere = (yield* f.chat.openChannel("别处", "", "")).id;
        yield* f.chat.orchestratorSays(elsewhere, "别处的话", "");
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
          // Handed to the orchestrator it woke: it says so.
          expect((yield* f.chat.history(general))[0]!.reactions).toEqual([{ emoji: "👀", by: [orchestratorAgent] }]);
          const reply = (yield* f.chat.say("补一句", undefined, "", { replyTo: first.number })).message;
          expect(reply.replyTo).toBe(first.number);
          expect(yield* Effect.flip(f.chat.say("没有这条", undefined, "", { replyTo: 99 }))).toMatchObject({ _tag: "Refused" });
          const since = (yield* f.chat.history(general)).at(-1)!.revision;

          const edited = yield* f.chat.edit(first.id, "改成这样");
          expect([edited.text, edited.edited !== undefined, edited.revision > since]).toEqual(["改成这样", true, true]);
          const theirs = (yield* f.chat.speak(orchestratorAgent, "我来看看", { anyway: true, confirm: true })).message!;
          expect(yield* Effect.flip(f.chat.edit(theirs.id, "不是你的"))).toMatchObject({ _tag: "Refused" });
          const liked = yield* f.chat.react(theirs.id, "owner", "👍");
          expect(liked.reactions).toEqual([{ emoji: "👍", by: ["owner"] }]);
          expect((yield* f.chat.react(theirs.id, "owner", "👍")).reactions).toBeUndefined();
          expect((yield* f.chat.pin(reply.id)).pinned).toBeDefined();
          expect((yield* f.chat.pins(general)).map((m) => m.id)).toEqual([reply.id]);
          expect((yield* f.chat.previewRemove(theirs.id)).does[0]).toContain(`第 ${theirs.number} 条`);
          yield* f.chat.remove(theirs.id);
          expect(yield* Effect.flip(f.chat.remove(theirs.id))).toMatchObject({ _tag: "Refused" });

          // What changed after since, each as it now is, in the order it changed.
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
          expect(yield* f.chat.threadUnder(reply.id)).toBe(thread);

          const file = yield* f.chat.attach({ name: "截图.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") });
          expect(file).toMatchObject({ name: "截图.png", type: "image/png", size: 9 });
          expect((yield* f.chat.attach({ name: "again.png", type: "image/png", data: Buffer.from("png bytes").toString("base64") })).id).toBe(file.id);
          const shown = (yield* f.chat.say("", undefined, "", { attachments: [file.id] })).message;
          expect(shown.attachments).toEqual([file]);
          const kept = yield* f.chat.attachment(file.id);
          expect(readFileSync(kept!.path, "utf8")).toBe("png bytes");
          expect((yield* f.chat.read(orchestratorAgent, { target: "#general", limit: 1 })).messages[0]!.attachments).toEqual([
            { name: "截图.png", path: kept!.path },
          ]);
          expect(yield* Effect.flip(f.chat.say("", undefined, "", { attachments: ["nope"] }))).toMatchObject({ _tag: "Missing" });
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
        for (let i = 0; i <= catchUpMax; i++) yield* f.chat.orchestratorSays(general, `第 ${i} 句`, "");
        const first = yield* Stream.runCollect(Stream.take(f.chat.follow(general, 0), 1));
        expect(first).toEqual([{ _tag: "Reset" }]);
        const near = yield* Stream.runCollect(Stream.take(f.chat.follow(general, 1), 1));
        expect(near.map((e) => e._tag === "Message" && e.message.number)).toEqual([2]);
        expect(yield* Effect.flip(Stream.runDrain(f.chat.follow("no-such-room", 0)))).toMatchObject({ _tag: "Refused" });
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
        expect(yield* Effect.flip(f.chat.say("早", undefined, "k".repeat(65)))).toMatchObject({ reason: "sendKey 太长" });
        for (let i = 0; i < 2; i++) yield* f.chat.spoken("owner", "电话里说的", "k3");
        const owners = () => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.from === "owner");
        yield* until(() => owners().length >= 5, "the owner's lines heard");
        const said: Record<string, number> = {};
        for (const m of owners()) said[m.text] = (said[m.text] ?? 0) + 1;
        expect(said).toEqual({ 早: 2, 晚: 2, 电话里说的: 1 });
        expect(yield* Effect.promise(() => f.deliveries(orchestratorAgent))).toHaveLength(4);
      }),
    ),
  );

  /** A trigger that refuses the write; each refusal moves the sequence <name>_tries on, which no rollback takes back. */
  const trigger = (sql: SqlClient.SqlClient, name: string, on: string, when = "") =>
    Effect.gen(function* () {
      yield* sql.unsafe(`create sequence ${name}_tries`);
      yield* sql.unsafe(
        `create function ${name}() returns trigger language plpgsql as $$ begin perform nextval('${name}_tries'); raise exception '${name}'; end $$`,
      );
      yield* sql.unsafe(`create trigger ${name} ${on} for each row ${when} execute function ${name}()`);
    }).pipe(Effect.orDie);
  const drop = (sql: SqlClient.SqlClient, name: string, table: string) => sql.unsafe(`drop trigger ${name} on ${table}`).pipe(Effect.orDie);

  it.live("a read receipt is written whole or not at all", () =>
    run((f) =>
      Effect.gen(function* () {
        const general = f.chat.defaultChannel();
        yield* f.chat.orchestratorSays(general, "hello", "");
        const [message] = yield* f.chat.history(general);
        yield* f.sql`insert into channel_seen_mark (participant_id, message_id) values ('owner', ${message!.id})`.pipe(Effect.orDie);
        yield* trigger(f.sql, "fail_receipt", "before delete on channel_seen_mark");
        expect((yield* Effect.exit(f.chat.markRead(general, message!.number)))._tag).toBe("Failure");
        expect(yield* f.sql`select read_number from channel_read_cursor where participant_id = 'owner' and channel_id = ${general}`.pipe(Effect.orDie)).toEqual(
          [],
        );
        // Nor is it read in what the chat shows next: what it kept in memory is read again from the database.
        yield* f.chat.notice(general, "动静", "test");
        expect(f.channel(general)?.read).toBeUndefined();
        yield* drop(f.sql, "fail_receipt", "channel_seen_mark");
        yield* f.chat.markRead(general, message!.number);
        expect(yield* f.sql`select read_number from channel_read_cursor where participant_id = 'owner' and channel_id = ${general}`.pipe(Effect.orDie)).toEqual(
          [{ read_number: message!.number }],
        );
        expect(f.channel(general)?.read).toBe(message!.number);
      }),
    ),
  );

  it.live("a job whose thread cannot be followed leaves no dispatch, and a second try writes one", () =>
    run((f) =>
      Effect.gen(function* () {
        yield* trigger(f.sql, "fail_owner", "before insert on channel_follow", "when (new.reason = 'owner')");
        yield* f.core.apply({
          type: "hired",
          session: {
            id: "w1",
            name: "helper",
            agent: "lab",
            runtime: "pi",
            brief: "work",
            hiredAt: Date.now(),
            runs: 0,
            phase: { _tag: "resting" },
          } as Session,
        });
        yield* waitFor(
          Effect.map(f.sql<{ n: string }>`select last_value::text as n from fail_owner_tries where is_called`.pipe(Effect.orDie), (rows) => rows.length),
          (n) => n > 0,
          "the job tried and refused",
        );
        expect(yield* f.chat.history(f.chat.defaultChannel())).toEqual([]);
        yield* drop(f.sql, "fail_owner", "channel_follow");
        // Another hire opens every job on the farm again.
        yield* f.core.apply({
          type: "hired",
          session: { id: "w2", name: "other", agent: "lab", runtime: "pi", brief: "more", hiredAt: Date.now(), runs: 0, phase: { _tag: "resting" } } as Session,
        });
        yield* until(() => f.messagesOf(f.chat.defaultChannel()).filter((m) => m.kind === "dispatch").length === 2, "both dispatched");
        const thread = (yield* f.chat.jobThread("w1"))!;
        expect((yield* f.sql`select participant_id from channel_follow where channel_id = ${thread}`.pipe(Effect.orDie)).map((r) => r.participant_id)).toEqual([
          "w1",
        ]);
      }),
    ),
  );
});
