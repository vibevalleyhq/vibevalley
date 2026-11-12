import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { user } from "#/base/actor.ts";
import { type SourceEvent } from "#/modules/mailbox/mailbox.ts";
import { sqlOf } from "#/testing/sql.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab } from "./farm.ts";

const event = (issue: string, key: string): SourceEvent => ({
  source: "connector",
  key,
  actor: { kind: "user", id: "user" },
  text: key,
  threads: [`issue:${issue}`],
  addressed: "thread_owner",
  at: 1,
});

test("regression: a consumed trigger can be handed back once without losing its source or consumption receipt", async () => {
  const f = farm({ runtime: scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") }) });
  await using fw = await f.open();
  const issue2 = fw.issue;
  const issues = testIssues(issue2);
  const mailbox = fw.mailbox;
  const sql = sqlOf(fw.db);
  await fw.agent.save(lab());
  const issue = await issues.add({ title: "work", repo: "handback-trigger", agent: "lab" });
  const started = await issues.start(issue.id, "");
  const trigger = (await mailbox.accept(event(issue.id, "beyond-original-scope")))!;
  const receipt = await sql`select routed_at, routing_scope, routing_position from mailbox_trigger where id = ${trigger.id}`;
  await await_(
    () => sql<{ state: string }>`select state from mailbox_delivery where session_id = ${started.session!} and envelope_id = ${trigger.id}`,
    (rows) => rows[0]?.state === "consumed",
    "the original input consumed",
  );
  await mailbox.decline(started.session!, trigger.id, "another work item");
  await mailbox.decline(started.session!, trigger.id, "duplicate retry");
  const returned = mailbox.deliveriesOf(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id);
  expect(returned).toHaveLength(1);
  expect(returned[0]!.envelope_id).not.toBe(trigger.id);
  expect(returned[0]!.payload.note).toContain("another work item");
  expect(returned[0]!.payload.trigger.meta.issue).toBeUndefined();
  expect((await mailbox.readTrigger(trigger.id))?.trigger).toEqual(trigger);
  expect(
    (await sql<{ state: string }>`select state from mailbox_delivery where session_id = ${started.session!} and envelope_id = ${trigger.id}`)[0]?.state,
  ).toBe("consumed");
  expect((await sql<{ state: string }>`select state from mailbox_issue where trigger_id = ${trigger.id}`)[0]?.state).toBe("returned");
  const rows2 = await sql`select routed_at, routing_scope, routing_position from mailbox_trigger where id = ${trigger.id}`;
  expect(rows2).toEqual(receipt);
  await mailbox.restore();
  expect(mailbox.deliveriesOf(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)).toHaveLength(1);
  const userEpoch = await sql<{ position: number }>`select max(position) as position from mailbox_user_route where scope = ${returned[0]!.scope}`;
  expect(userEpoch[0]!.position).toBe(returned[0]!.position);
});

test("regression: closing an unassigned issue returns its held user input without a machine chat message", async () => {
  const f = farm();
  await using fw = await f.open();
  const service = fw.issue;
  const issues = testIssues(service);
  const mailbox = fw.mailbox;
  const chat = fw.channel;
  const sql = sqlOf(fw.db);
  const issue = await issues.add({ title: "waiting", repo: "unassigned-return" });
  const source = event(issue.id, "unread-user-followup");
  const trigger = (await mailbox.accept(source))!;
  await service.setStatus(issue.id, "canceled", "", "", user);
  await await_(
    () => Promise.resolve(mailbox.deliveriesOf(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)),
    (rows) => rows.length === 1,
    "held input returned on cancel",
  );
  await mailbox.accept(source);
  expect(mailbox.deliveriesOf(defaultOrchestrator).filter((row) => row.payload.trigger.id === trigger.id)).toHaveLength(1);
  expect((await sql<{ state: string }>`select state from mailbox_issue where trigger_id = ${trigger.id}`)[0]?.state).toBe("returned");
  expect((await chat.history(chat.defaultChannel())).some((message) => message.text.includes(source.text))).toBe(false);
});
