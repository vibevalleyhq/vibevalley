import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { channelOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { user } from "#/base/actor.ts";
import { sqlOf } from "#/testing/sql.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab, until } from "./farm.ts";

describe("an issue's thread", () => {
  test("an agent's words to an issue's session are said where it works, a recorded trigger delivered to it", async () => {
    // Issue.comment by an agent: once the watch's tell, now said in the session's home and routed (and braked) there.
    const f = farm();
    await using fw = await f.open();
    await fw.agent.save(lab());
    const issues = testIssues(fw.issue);
    const issue = await issues.add({ title: "看看", repo: "told", agent: "lab" });
    const started = await issues.start(issue.id, "");
    const session = started.session!;
    const thread = (await await_(
      () => fw.channel.homeOf(session),
      (id) => id !== undefined,
      "its thread",
    ))!;
    const orchestrator = fw.channel.orchestratorIn(thread);
    const receipt = await fw.issue.comment(issue.id, "直接说给它", "told", { kind: "agent", id: orchestrator, role: "orchestrator" });
    expect(receipt.worker?.id).toBe(session);
    const said = (await fw.channel.history(thread)).find((m) => m.text === "直接说给它")!;
    expect(said.from).toBe(orchestrator);
    expect(await fw.session.trigger(said.id)).toBeDefined();
    // Delivered to its session (which takes it once its issue is not waiting on the user).
    const [delivery] = await sqlOf(fw.db).unsafe(`select reason, held_by from session_delivery where session_id = $1 and envelope_id = $2`, [session, said.id]);
    expect(delivery).toMatchObject({ reason: "own_thread", held_by: null });
  });

  test("regression: closing an issue releases an unconsumed followup through the mailbox", async () => {
    const f = farm({
      runtime: scriptedRuntime({
        id: "pi",
        turn: (turn) =>
          new Promise<void>((resolve) => {
            turn.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    });
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const chat = fw.channel;
    const mailbox = fw.inside;
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "还在处理", repo: "release-input", agent: "lab" });
    const started = await issues.start(issue.id, "");
    const thread = (await await_(
      () => chat.homeOf(started.session!),
      (id) => id !== undefined,
      "the issue thread",
    ))!;
    const followup = (await chat.say({ text: "这条还没处理", channel: thread, sendKey: "release-on-close" })).message;
    await await_(
      () => Promise.resolve(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === followup.id)?.channel_id),
      (id) => id === thread,
      "the followup stored",
    );
    await fw.issue.setStatus(issue.id, "canceled", "", "", user);
    const returned = await await_(
      () => Promise.resolve(mailbox.deliveriesOf(chat.orchestratorIn(thread)).filter((row) => row.envelope_id === `returned:${issue.id}:${followup.id}`)),
      (rows) => rows.length === 1,
      "the unread followup returned",
    );
    expect(returned[0]!.payload.trigger.card.readUri).toBe(`vv://trigger/${followup.id}`);
    expect((await chat.history(thread)).some((message) => message.text.includes(`vv://trigger/${followup.id}`))).toBe(false);
  });
  test("regression: a queued issue accepts comments before it has a session", async () => {
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
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const channels = fw.channel;
    const sessions = fw.inside;
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "等待派发", repo: "queued", agent: "lab" });
    await issues.comment(issue.id, "先记下验收要求", "queued-comment");
    await issues.comment(issue.id, "先记下验收要求", "queued-comment");
    const thread = await channels.issueThread(issue.id, issue.title);
    expect((await channels.history(thread)).map((message) => message.text)).toEqual(["先记下验收要求"]);
    expect(sessions.hired()).toEqual([]);
    expect((await issues.get(issue.id)).status).toBe("backlog");
    await issues.start(issue.id, "");
    await until(() => inputs.length > 0, "the queued input delivered with the first assignment");
    expect(inputs[0]).toContain("先记下验收要求");
    const followup = (await channels.say({ text: "另一个需求", channel: thread, sendKey: "handback-source" })).message;
    const session = sessions.hired()[0]!;
    const mailbox = fw.inside;
    await await_(
      () => Promise.resolve(mailbox.deliveriesOf(session.id).find((row) => row.envelope_id === followup.id)?.channel_id),
      (channel) => channel === thread,
      "the followup owned by the session",
    );
    await fw.inside.decline(session.id, followup.id, "超出当前范围");
    await fw.inside.decline(session.id, followup.id, "超出当前范围");
    const returned = mailbox.deliveriesOf(channels.orchestratorIn(thread)).filter((row) => row.envelope_id === `returned:${issue.id}:${followup.id}`);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.payload.trigger.id).toBe(followup.id);
  });
  // One issue, one thread: sent out, cancelled and reopened, both sessions' dispatch, reports and the person's words are in the same thread.
  test("is one across its sessions", async () => {
    // Says only that it is done: echoing its input would @ the orchestrator, who would then follow the thread.
    const f = farm({
      runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("做好了") }),
    });
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const channels = fw.channel;
    const sessions = fw.inside;
    const core = fw.core;
    const { in: saidIn } = fw.said;
    const sql = sqlOf(fw.db);
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "写打卡", repo: "one-thread", agent: "lab" });
    const sent = await issues.start(issue.id, "");
    const first = sent.session!;
    expect(first).toBeDefined();
    const thread = await await_(
      async () => {
        const id = await channels.homeOf(first);
        return id ? channelOf(core.state().chat, id) : undefined;
      },
      (c): c is T.Channel => c !== undefined,
      "the issue's thread",
    );
    expect([thread!.subjectKind, thread!.subjectId]).toEqual(["issue", issue.id]);
    const inThread = (): T.ChatMessage[] => saidIn(thread!.id);
    const reportsBy = (session: string) => inThread().filter((m) => m.kind === "report" && m.from === session).length;
    await until(() => reportsBy(first) === 1, "the first session's report");
    await channels.say({ text: "把输出改成中文", channel: thread!.id, sendKey: "" });
    await until(() => reportsBy(first) === 2, "the person's words wake the first session");

    await sessions.dismiss(first);
    await await_(
      () => issues.get(issue.id),
      (i) => i.closedAt !== undefined,
      "cancelled",
    );
    const kept = await channels.say({ text: "先记一下：时区用东八区", channel: thread!.id, sendKey: "" });
    const woken = await sql<{
      n: number;
    }>`select count(*) as n from session_delivery where message_id = ${kept.message.id} and session_id = ${first}`;
    expect(woken[0]!.n).toBe(0);
    const rows = await sql`select trigger_id from session_issue_input where trigger_id = ${kept.message.id} and state = 'returned'`;
    expect(rows).toHaveLength(1);

    const setStatus2 = await issues.setStatus(issue.id, "todo", "接着做", "", user);
    const second = latestSessionIdOf(setStatus2);
    if (second === undefined) throw new Error("the issue has no reopened session");
    await until(() => reportsBy(second) === 1, "the second session's report in the same thread");
    const threadOfSession2 = await channels.homeOf(second);
    expect(threadOfSession2).toBe(thread!.id);
    const handed = inThread().find((m) => m.kind === "dispatch" && m.session === second);
    expect(handed?.text).toContain("@" + second);
    expect(handed?.text).toContain("第 2 次");
    await channels.say({ text: "时区记得改", channel: thread!.id, sendKey: "" });
    await until(() => reportsBy(second) === 2, "the person's words wake the second session");
    expect(reportsBy(first)).toBe(2);

    const threads = (core.state().chat?.channels ?? []).filter((c) => c.subjectKind === "issue" && c.subjectId === issue.id).map((c) => c.id);
    expect(threads).toEqual([thread!.id]);
  });

  // The issue hears the user in its thread whichever way the words came: said in the thread, they answer its question and void a pass as a comment does.
  test("hears the user's words as a comment", async () => {
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
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const channels = fw.channel;
    const sessions = fw.inside;
    const inbox = fw.watch;
    const { in: saidIn } = fw.said;
    await fw.agent.save(lab());
    const issue = await issues.add({
      title: "先问清楚，再写打卡",
      repo: "clock",
      agent: "lab",
    });
    const sent = await issues.start(issue.id, "");
    const thread = (await await_(
      () => channels.homeOf(sent.session!),
      (id) => id !== undefined,
      "the issue's thread",
    ))!;
    const get = () => issues.get(issue.id);
    await until(() => sessions.runOf(sent.session!) !== undefined, "the first run");
    await sessions.report(sent.session!, {
      summary: "需要端口",
      questions: [{ question: "用 8787 还是 8797？", options: ["用 8787", "用 8797"] }],
      checks: [],
      remember: [],
      prSubmit: false,
    });
    first.resolve();
    await await_(get, (i) => i.questions.length === 1, "its question");

    const question = (await await_(
      () => saidIn(thread).findLast((message) => message.kind === "report"),
      (message) => message !== undefined,
      "the question handoff",
    ))!;
    await await_(
      () => inbox.handoffState(question.id),
      (state) => state === "unseen",
      "the question unseen",
    );
    await channels.markRead(thread, question.number);
    await await_(
      () => inbox.handoffState(question.id),
      (state) => state === "seen",
      "the question seen",
    );

    await channels.say({ text: "用 8797", channel: thread, sendKey: "" });
    await await_(
      () => inbox.handoffState(question.id),
      (state) => state === undefined,
      "the question acted on",
    );
    await await_(get, (i) => i.questions.length === 0, "answered in the thread");
    await await_(get, (i) => i.status === "in_review", "handed back");
    await issues.review(issue.id, { pass: true });
    expect((await get()).reviewedAt).toBeDefined();
    await channels.say({ text: "标题再短一点", channel: thread, sendKey: "" });
    await await_(get, (i) => i.reviewedAt === undefined, "another round voids the pass");

    const said = () => saidIn(thread).filter((m) => m.from === "user" && m.text === "顺手把注释删掉").length;
    for (let i = 0; i < 2; i++) await issues.comment(issue.id, "顺手把注释删掉", "k1");
    await until(() => said() > 0, "the comment in the thread");
    expect(said()).toBe(1);
  });
});
