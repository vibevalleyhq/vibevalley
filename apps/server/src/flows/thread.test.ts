import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { ChatMessage, Channel } from "@vibevalley/protocol";
import { channelOf } from "@/channel/folded.ts";
import { Said } from "@/testing/said.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "@/agent/agent.ts";
import { Channels } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { Issues } from "@/issue/issue.ts";
import { Sessions } from "@/session/session.ts";
import { await_, farm, lab, until } from "./farm.ts";

describe("an issue's thread", () => {
  // One issue, one thread: sent out, cancelled and reopened, both sessions' dispatch, reports and the person's words are
  // in the same thread; the person's words wake the session working the issue now, and only keep when none is.
  it.live("is one across its sessions", () => {
    // Says only that it is done: echoing its input would @ the orchestrator, who would then follow the thread.
    const f = farm({
      runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做好了") }),
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const channels = yield* Channels;
      const sessions = yield* Sessions;
      const core = yield* Core;
      const { in: saidIn } = yield* Said;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agents).save(lab());
      const issue = yield* issues.add({ title: "写打卡", project: "one-thread", assignee: "lab" });
      const sent = yield* issues.start(issue.id, "");
      const first = sent.session!;
      expect(first).toBeDefined();
      const thread = yield* await_(
        () => Effect.map(channels.jobThread(first), (id) => (id ? channelOf(core.state().chat, id) : undefined)),
        (c): c is Channel => c !== undefined,
        "the issue's thread",
      );
      expect([thread!.subjectKind, thread!.subjectId]).toEqual(["issue", issue.id]);
      const inThread = (): ChatMessage[] => saidIn(thread!.id);
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
      }>`select count(*)::int as n from channel_delivery where message_id = ${kept.message.id}`.pipe(Effect.orDie);
      expect(woken[0]!.n).toBe(0);

      const second = yield* issues.reopen(issue.id, "接着做", "");
      yield* until(() => reportsBy(second) === 1, "the second session's report in the same thread");
      expect(yield* channels.jobThread(second)).toBe(thread!.id);
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
    const f = farm();
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const channels = yield* Channels;
      const { in: saidIn } = yield* Said;
      yield* (yield* Agents).save(lab());
      const issue = yield* issues.add({
        title: "先问清楚，再写打卡",
        project: "clock",
        assignee: "lab",
      });
      const sent = yield* issues.start(issue.id, "");
      const thread = (yield* await_(
        () => channels.jobThread(sent.session!),
        (id) => id !== undefined,
        "the issue's thread",
      ))!;
      const get = () => issues.get(issue.id);
      yield* await_(get, (i) => i.questions.length === 1, "its question");

      yield* channels.say("用 8797", thread, "");
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
