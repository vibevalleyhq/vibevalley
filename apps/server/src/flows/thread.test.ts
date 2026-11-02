import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import type * as T from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Channel } from "@/channel/chat.ts";
import { channelOf } from "@/channel/folded.ts";
import { Core } from "@/core/core.ts";
import { Inbox } from "@/inbox/inbox.ts";
import { Issue } from "@/issue/issue.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { Session } from "@/session/session.ts";
import { testIssues } from "@/testing/issues.ts";
import { Said } from "@/testing/said.ts";

import { await_, farm, lab, until } from "./farm.ts";

describe("an issue's thread", () => {
  it.live("regression: closing an issue releases an unconsumed followup through the mailbox", () => {
    const f = farm({
      runtime: scriptedRuntime({
        id: "pi",
        turn: (turn) =>
          new Promise<void>((resolve) => {
            turn.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    });
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const chat = yield* Channel;
      const mailbox = yield* Mailbox;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "还在处理", project: "release-input", agent: "lab" });
      const started = yield* issues.start(issue.id, "");
      const thread = (yield* await_(
        () => chat.threadOfSession(started.session!),
        (id) => id !== undefined,
        "the issue thread",
      ))!;
      const followup = (yield* chat.say("这条还没处理", thread, "release-on-close")).message;
      yield* await_(
        () => Effect.succeed(mailbox.pending(started.session!).find((row) => row.envelope_id === followup.id)?.channel_id),
        (id) => id === thread,
        "the followup stored",
      );
      yield* (yield* Issue).setStatus(issue.id, "canceled", "", "", owner);
      const returned = yield* await_(
        () => Effect.succeed(mailbox.pending(chat.orchestratorOf(thread)).filter((row) => row.envelope_id === `returned:${issue.id}:${followup.id}`)),
        (rows) => rows.length === 1,
        "the unread followup returned",
      );
      expect(returned[0]!.payload.trigger.card.readUri).toBe(`vv://trigger/${followup.id}`);
      expect((yield* chat.history(thread)).some((message) => message.text.includes(`vv://trigger/${followup.id}`))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
  it.live("regression: a queued issue accepts comments before it has a session", () => {
    const inputs: string[] = [];
    const f = farm({
      runtime: scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          inputs.push(turn.input);
          turn.say("收到");
        },
      }),
    });
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const channels = yield* Channel;
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "等待派发", project: "queued", agent: "lab" });
      yield* issues.comment(issue.id, "先记下验收要求", "queued-comment");
      yield* issues.comment(issue.id, "先记下验收要求", "queued-comment");
      const thread = yield* channels.issueThread(issue.id, issue.title);
      expect((yield* channels.history(thread)).map((message) => message.text)).toEqual(["先记下验收要求"]);
      expect(sessions.presentSessions()).toEqual([]);
      expect((yield* issues.get(issue.id)).status).toBe("backlog");
      yield* issues.start(issue.id, "");
      yield* until(() => inputs.length > 0, "the queued input delivered with the first assignment");
      expect(inputs[0]).toContain("先记下验收要求");
      const followup = (yield* channels.say("另一个需求", thread, "handback-source")).message;
      const session = sessions.presentSessions()[0]!;
      const mailbox = yield* Mailbox;
      yield* await_(
        () => Effect.succeed(mailbox.pending(session.id).find((row) => row.envelope_id === followup.id)?.channel_id),
        (channel) => channel === thread,
        "the followup owned by the session",
      );
      yield* (yield* Mailbox).returnInput(session.id, followup.id, "超出当前范围");
      yield* (yield* Mailbox).returnInput(session.id, followup.id, "超出当前范围");
      const returned = mailbox.pending(channels.orchestratorOf(thread)).filter((row) => row.envelope_id === `returned:${issue.id}:${followup.id}`);
      expect(returned).toHaveLength(1);
      expect(returned[0]!.payload.trigger.id).toBe(followup.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
  // One issue, one thread: sent out, cancelled and reopened, both sessions' dispatch, reports and the person's words are
  // in the same thread; the person's words wake the session working the issue now, and only keep when none is.
  it.live("is one across its sessions", () => {
    // Says only that it is done: echoing its input would @ the orchestrator, who would then follow the thread.
    const f = farm({
      runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做好了") }),
    });
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const channels = yield* Channel;
      const sessions = yield* Session;
      const core = yield* Core;
      const { in: saidIn } = yield* Said;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "写打卡", project: "one-thread", agent: "lab" });
      const sent = yield* issues.start(issue.id, "");
      const first = sent.session!;
      expect(first).toBeDefined();
      const thread = yield* await_(
        () => Effect.map(channels.threadOfSession(first), (id) => (id ? channelOf(core.state().chat, id) : undefined)),
        (c): c is T.Channel => c !== undefined,
        "the issue's thread",
      );
      expect([thread!.subjectKind, thread!.subjectId]).toEqual(["issue", issue.id]);
      const inThread = (): T.ChatMessage[] => saidIn(thread!.id);
      const reportsBy = (session: string) => inThread().filter((m) => m.kind === "report" && m.from === session).length;
      yield* until(() => reportsBy(first) === 1, "the first session's report");
      yield* channels.say("把输出改成中文", thread!.id, "");
      yield* until(() => reportsBy(first) === 2, "the person's words wake the first session");

      yield* sessions.dismiss(first);
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.closedAt !== undefined,
        "cancelled",
      );
      const kept = yield* channels.say("先记一下：时区用东八区", thread!.id, "");
      const woken = yield* sql<{
        n: number;
      }>`select count(*)::int as n from mailbox_delivery where message_id = ${kept.message.id} and session_id = ${first}`.pipe(Effect.orDie);
      expect(woken[0]!.n).toBe(0);
      expect(yield* sql`select trigger_id from mailbox_issue where trigger_id = ${kept.message.id} and state = 'returned'`).toHaveLength(1);

      const second = latestSessionIdOf(yield* issues.setStatus(issue.id, "todo", "接着做", "", owner));
      if (second === undefined) throw new Error("the issue has no reopened session");
      yield* until(() => reportsBy(second) === 1, "the second session's report in the same thread");
      expect(yield* channels.threadOfSession(second)).toBe(thread!.id);
      const handed = inThread().find((m) => m.kind === "dispatch" && m.session === second);
      expect(handed?.text).toContain("@" + second);
      expect(handed?.text).toContain("第 2 次");
      yield* channels.say("时区记得改", thread!.id, "");
      yield* until(() => reportsBy(second) === 2, "the person's words wake the second session");
      expect(reportsBy(first)).toBe(2);

      const threads = (core.state().chat?.channels ?? []).filter((c) => c.subjectKind === "issue" && c.subjectId === issue.id).map((c) => c.id);
      expect(threads).toEqual([thread!.id]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // The issue hears the owner in its thread whichever way the words came: said in the thread, they answer its question
  // and void a pass as a comment does; a comment sent twice with one key is said once.
  it.live("hears the owner's words as a comment", () => {
    const first = Promise.withResolvers<void>();
    let turns = 0;
    const f = farm({
      runtime: scriptedRuntime({
        id: "pi",
        turn: async (turn) => {
          if (turns++ === 0) await first.promise;
          turn.say("做好了");
        },
      }),
    });
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      const channels = yield* Channel;
      const sessions = yield* Session;
      const inbox = yield* Inbox;
      const { in: saidIn } = yield* Said;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({
        title: "先问清楚，再写打卡",
        project: "clock",
        agent: "lab",
      });
      const sent = yield* issues.start(issue.id, "");
      const thread = (yield* await_(
        () => channels.threadOfSession(sent.session!),
        (id) => id !== undefined,
        "the issue's thread",
      ))!;
      const get = () => issues.get(issue.id);
      yield* until(() => sessions.runOf(sent.session!) !== undefined, "the first run");
      yield* sessions.report(sent.session!, {
        summary: "需要端口",
        questions: [{ question: "用 8787 还是 8797？", options: ["用 8787", "用 8797"] }],
        checks: [],
        remember: [],
        prSubmit: false,
      });
      first.resolve();
      yield* await_(get, (i) => i.questions.length === 1, "its question");

      const question = (yield* await_(
        () => saidIn(thread).findLast((message) => message.kind === "report"),
        (message) => message !== undefined,
        "the question handoff",
      ))!;
      yield* await_(
        () => inbox.handoffState(question.id),
        (state) => state === "unseen",
        "the question unseen",
      );
      yield* channels.markRead(thread, question.number);
      yield* await_(
        () => inbox.handoffState(question.id),
        (state) => state === "seen",
        "the question seen",
      );

      yield* channels.say("用 8797", thread, "");
      yield* await_(
        () => inbox.handoffState(question.id),
        (state) => state === undefined,
        "the question acted on",
      );
      yield* await_(get, (i) => i.questions.length === 0, "answered in the thread");
      yield* await_(get, (i) => i.status === "in_review", "handed back");
      yield* issues.review(issue.id, { pass: true });
      expect((yield* get()).reviewedAt).toBeDefined();
      yield* channels.say("标题再短一点", thread, "");
      yield* await_(get, (i) => i.reviewedAt === undefined, "another round voids the pass");

      const said = () => saidIn(thread).filter((m) => m.from === "owner" && m.text === "顺手把注释删掉").length;
      for (let i = 0; i < 2; i++) yield* issues.comment(issue.id, "顺手把注释删掉", "k1");
      yield* until(() => said() > 0, "the comment in the thread");
      expect(said()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
