import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { explicitMandate } from "#/modules/issue/creation.ts";
import { type InsertDelivery } from "#/modules/session/mailbox.ts";
import { committedDelivery } from "#/testing/deliveries.ts";
import { sqlOf } from "#/testing/sql.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab, until, failure } from "./farm.ts";

test("regression: the mandate grants its worker access to the original trigger without granting another issue access", async () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  await using fw = await f.open();
  const mailbox = fw.inside;
  const issues = fw.issue;
  const tools = fw.tool;
  await fw.agent.save(lab());
  const source = (await mailbox.record({
    source: "workbench",
    key: "mandate-source",
    actor: { kind: "user", id: "user" },
    addressed: "direct",
    threads: [],
    text: "original requirement",
    at: 1,
  }))!;
  const item = await issues.add({ title: "authorized work", repo: "mandate", agent: "lab" }, explicitMandate(source.id));
  const started = await testIssues(issues).start(item.id, "");
  await until(() => inputs.some((input) => input.includes(source.card.readUri)), "the worker given the original source");
  expect((await tools.readResource(started.session!, { uri: source.card.readUri })).text).toContain("original requirement");
  const other = await issues.add({ title: "unrelated work", repo: "unrelated", agent: "lab" }, explicitMandate());
  const second = await testIssues(issues).start(other.id, "");
  const resourceFailure = await failure(tools.readResource(second.session!, { uri: source.card.readUri }));
  expect(resourceFailure).toMatchObject({ name: "ResourceError" });
});

test("regression: chat triggers keep their original payload through edits and replay and expose neighboring messages", async () => {
  const f = farm();
  await using fw = await f.open();
  const chat = fw.channel;
  const mailbox = fw.inside;
  const tools = fw.tool;
  const sql = sqlOf(fw.db);
  const before = await chat.say({ text: "previous message", sendKey: "before" });
  const current = await chat.say({ source: "voice", text: "original voice input", sendKey: "voice-source" });
  await chat.say({ text: "next message", sendKey: "after" });
  await chat.edit(current.message.id, "edited voice input");
  await sql`update session_trigger set routed_at = null, routing_scope = null, routing_position = null where id = ${current.message.id}`;
  // As a crash before the route left it: the watch's cursor still before the message.
  await sql`update watch_cursor set seq = (select seq - 1 from channel_event where message_id = ${current.message.id} and kind = 'posted')`;
  await fw.inside.replay();
  const registered2 = await mailbox.isRouted(current.message.id);
  expect(registered2).toBe(false);
  await fw.watch.boot();
  await mailbox.wake();
  const registered3 = await mailbox.isRouted(current.message.id);
  expect(registered3).toBe(true);
  const source = await mailbox.readTrigger(current.message.id);
  expect(source?.trigger.source).toBe("voice");
  expect(source?.payload.text).toBe("original voice input");
  expect(source?.trigger.card.readUri).toBe(`vv://trigger/${current.message.id}`);
  const resource = await tools.readResource(defaultOrchestrator, { uri: source!.trigger.card.readUri });
  expect(resource.text).toContain("original voice input");
  expect(resource.text).toContain(before.message.id);
  expect(resource.text).toContain("next message");
});

test("regression: a persisted machine trigger reaches a worker without a chat message", async () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  await using fw = await f.open();
  const issue2 = fw.issue;
  const issues = testIssues(issue2);
  const sessions = fw.inside;
  const mailbox = fw.inside;
  const chat = fw.channel;
  await fw.agent.save(lab());
  const issue = await issues.add({ title: "work", repo: "machine-trigger", agent: "lab" });
  const started = await issues.start(issue.id, "");
  const session = started.session!;
  await until(() => sessions.sessionOf(session)?.phase._tag === "done", "the worker waiting");
  const thread = (await await_(
    () => chat.homeOf(session),
    (id) => id !== undefined,
    "the worker thread",
  ))!;
  const trigger = (await mailbox.record({
    source: "github",
    key: "ci:1",
    actor: { kind: "system", id: "checks" },
    addressed: "thread_owner",
    text: "machine-only-detail ".repeat(100),
    threads: [`issue:${issue.id}`],
    replyChannel: thread,
    at: 1,
  }))!;
  const delivery: InsertDelivery = {
    session,
    row: {
      envelope_id: trigger.id,
      scope: `issue:${issue.id}`,
      message_id: null,
      channel_id: thread,
      source: trigger.source,
      urgency: "queue",
      reason: "addressed",
      wakes: true,
      held_by: null,
      state: "pending",
      launch: null,
      created_at: trigger.at,
      payload: { trigger, context: { number: 0, target: trigger.card.readUri }, channelType: "thread" },
    },
  };
  await committedDelivery(fw.db, delivery);
  await mailbox.restoreDeliveries();
  expect(mailbox.deliveriesOf(session).find((row) => row.envelope_id === trigger.id)?.message_id).toBeNull();
  await mailbox.wake();
  expect(inputs.some((input) => input.includes(trigger.card.readUri))).toBe(false);
  await mailbox.accept({
    source: "connector",
    key: "resume-machine-work",
    actor: { kind: "user", id: "user" },
    addressed: "thread_owner",
    threads: [`issue:${issue.id}`],
    replyChannel: thread,
    text: "handle the queued input",
    at: 2,
  });
  await until(() => inputs.some((input) => input.includes(trigger.card.readUri)), "the machine card delivered");
  await until(() => mailbox.deliveriesOf(session).every((row) => row.envelope_id !== trigger.id), "the actual input consumed");
  await committedDelivery(fw.db, delivery);
  expect(mailbox.deliveriesOf(session).some((row) => row.envelope_id === trigger.id)).toBe(false);
  const messages = await await_(
    () => chat.history(thread),
    (items) => items.some((message) => message.kind === "report"),
    "the worker report",
  );
  expect(messages.some((message) => message.text.includes("machine-only-detail"))).toBe(false);
});

test("regression: issue input waits without a session and a user followup releases frozen machine input", async () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("done");
      },
    }),
  });
  await using fw = await f.open();
  const issue2 = fw.issue;
  const issues = testIssues(issue2);
  const sessions = fw.inside;
  const mailbox = fw.inside;
  const tools = fw.tool;
  const sql = sqlOf(fw.db);
  await fw.agent.save(lab());
  const issue = await issues.add({ title: "subscription work", repo: "source-routing", agent: "lab" });
  await mailbox.subscribe(issue.id, ["github:source-routing#7"]);
  const userEvent = {
    source: "connector" as const,
    key: "queued-user",
    actor: { kind: "user" as const, id: "user" },
    text: "queued-user-detail",
    threads: ["github:source-routing#7"],
    addressed: "thread_owner" as const,
    at: 1,
  };
  const queued = (await mailbox.accept(userEvent))!;
  expect(sessions.hired()).toHaveLength(0);
  expect((await sql<{ state: string }>`select state from session_issue_input where trigger_id = ${queued.id}`)[0]?.state).toBe("held");
  const started = await issues.start(issue.id, "");
  await until(() => inputs.some((input) => input.includes("queued-user-detail")), "the queued input delivered");
  expect(inputs[0]).toContain("queued-user-detail");
  await until(() => sessions.sessionOf(started.session!)?.phase._tag === "done", "the worker handed back");
  const automatic = (await mailbox.accept({
    source: "github",
    key: "ci-failure",
    actor: { kind: "system", id: "checks" },
    text: "frozen-ci-detail",
    threads: ["github:source-routing#7"],
    addressed: "thread_owner",
    at: 2,
  }))!;
  expect((await sql<{ state: string; reason: string }>`select state, reason from session_issue_input where trigger_id = ${automatic.id}`)[0]).toEqual({
    state: "held",
    reason: "human",
  });
  expect(inputs.some((input) => input.includes("frozen-ci-detail"))).toBe(false);
  await mailbox.accept(userEvent);
  expect((await sql<{ state: string }>`select state from session_issue_input where trigger_id = ${automatic.id}`)[0]?.state).toBe("held");
  await mailbox.accept({ ...userEvent, key: "release-user", text: "release-user-detail", at: 3 });
  await until(() => inputs.some((input) => input.includes("frozen-ci-detail")), "the frozen input released");
  expect((await issues.list()).map((item) => item.id)).toEqual([issue.id]);
  expect((await sql<{ session_id: string }>`select session_id from session_issue_input where trigger_id = ${automatic.id}`)[0]?.session_id).toBe(
    started.session,
  );
  expect((await tools.readResource(started.session!, { uri: automatic.card.readUri })).text).toContain("frozen-ci-detail");
});
