import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { moduleWorld } from "#/testing/world.ts";

import { type TriggerInput, triggerOf } from "./payload.ts";

const event: TriggerInput = {
  source: "github",
  key: "repo#7:review:42",
  actor: { kind: "system", id: "reviewer" },
  text: "original review",
  data: { detail: "original" },
  threads: ["github:repo#7"],
  addressed: "thread_owner",
  meta: { repo: "repo", pr: 7, botRound: 1, botRoundKey: "round-1" },
  at: 10,
};

test("regression: duplicate source and channel records keep the first trigger and payload", async () => {
  await using farm = await moduleWorld();
  const { inside: mailbox } = farm;
  const first = await mailbox.recordTrigger(event);
  const triggerRecorded = await mailbox.recordTrigger({ ...event, text: "changed", data: null, at: 20 });
  expect(triggerRecorded).toEqual(first);
  expect((await mailbox.readTrigger(first.id))?.payload).toEqual({ text: event.text, data: event.data });
  const message = {
    ...event,
    id: "message",
    source: "channel" as const,
    key: "message",
    text: "first",
    data: { kind: "channel_message", message: "message", channel: "room" },
  };
  const channel = triggerOf(message);
  const channelTriggerRecorded = await mailbox.recordTrigger(message);
  expect(channelTriggerRecorded).toEqual(channel);
  const channelTriggerRecorded2 = await mailbox.recordTrigger({
    ...message,
    at: 20,
    text: "changed",
    data: { kind: "channel_message", message: "message", channel: "other" },
  });
  expect(channelTriggerRecorded2).toEqual(channel);
  expect((await mailbox.readTrigger(channel.id))?.payload).toEqual({
    text: "first",
    data: { kind: "channel_message", message: channel.id, channel: "room" },
  });
});

test("regression: cron replay supplies decoded source payloads without routing them", async () => {
  await using farm = await moduleWorld();
  const { inside: mailbox } = farm;
  const first = await mailbox.recordTrigger({ ...event, source: "cron", key: "first", data: { occurrence: 1 } });
  const second = await mailbox.recordTrigger({ ...event, source: "cron", key: "second", data: { occurrence: 2 } });
  await mailbox.recordTrigger({
    ...event,
    id: "voice-msg",
    source: "voice",
    key: "voice-msg",
    data: { kind: "channel_message", message: "voice-msg", channel: "room" },
  });
  const seen: unknown[] = [];
  await mailbox.unrouted(async (trigger, data) => void seen.push({ id: trigger.id, source: trigger.source, data }));
  expect(seen).toEqual([
    { id: first.id, source: "cron", data: { occurrence: 1 } },
    { id: second.id, source: "cron", data: { occurrence: 2 } },
  ]);
  const registered2 = await mailbox.isRouted(first.id);
  expect(registered2).toBe(false);
  const registered3 = await mailbox.isRouted(second.id);
  expect(registered3).toBe(false);

  const agentSignal = await mailbox.recordTrigger({
    ...event,
    source: "workbench",
    key: "agent-wake",
    actor: { kind: "agent", role: "worker", id: "w1", name: "Helper" },
  });
  await mailbox.route(agentSignal, [{ session: sessionId(defaultOrchestrator), heard: { reason: "addressed", wakes: true } }]);
  const beforeUser = (await mailbox.agentWakes()).scopes;
  expect(beforeUser).toEqual([{ scope: expect.stringMatching(/^channel:/u), n: 1 }]);

  const userSignal = await mailbox.recordTrigger({
    ...event,
    source: "workbench",
    key: "user-returned",
    actor: { kind: "user", id: "user" },
  });
  await mailbox.route(userSignal, [], "issue:1");
  expect((await mailbox.agentWakes()).scopes).toEqual(beforeUser);
  await mailbox.route(userSignal, [{ session: sessionId(defaultOrchestrator), id: `returned:1:${userSignal.id}` }]);
  expect((await mailbox.agentWakes()).scopes).toEqual([]);
  const deliveryRows = await farm.db.sql.query("select trigger_id, actor_kind from session_delivery where envelope_id = $1", [`returned:1:${userSignal.id}`]);
  expect(deliveryRows).toEqual([{ trigger_id: userSignal.id, actor_kind: "user" }]);
  await farm.db.sql.exec("delete from session_trigger where id = $1", [userSignal.id]);
  const afterCascade = await farm.db.sql.query("select count(*)::int as n from session_delivery where trigger_id = $1", [userSignal.id]);
  expect(afterCascade).toEqual([{ n: 0 }]);
});
