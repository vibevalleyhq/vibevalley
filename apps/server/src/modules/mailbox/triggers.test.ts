import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { moduleWorld } from "#/testing/world.ts";
import * as cursor from "#db/issue_github.sql.ts";
import { allOpenDeliveries } from "#db/mailbox_delivery.sql.ts";

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

test("regression: the source cursor and Mailbox trigger share commit and rollback without routing", async () => {
  await using farm = await moduleWorld();
  const { mailbox, db, core } = farm;
  const state = core.state();
  const scope = { repo: "repo", pr_number: 7 };
  const id = triggerOf(event).id;
  await cursor.ensureGitHubCursor(db.sql, scope);
  const write = async () => {
    await cursor.observeGitHubChecks(db.sql, { ...scope, check_fingerprint: "changed", check_revision: 1 });
    return mailbox.recordTrigger(event);
  };
  const rolledBack = await db
    .tx(async () => {
      await write();
      throw new Error("rollback");
    })
    .then(
      () => "committed",
      () => "failed",
    );
  expect(rolledBack).toBe("failed");
  const trigger2 = await mailbox.readTrigger(id);
  expect(trigger2).toBeUndefined();
  expect((await cursor.gitHubCursor(db.sql, scope))?.check_revision).toBe(0);
  const trigger = await db.tx(write);
  expect((await cursor.gitHubCursor(db.sql, scope))?.check_revision).toBe(1);
  expect((await mailbox.readTrigger(id))?.trigger).toEqual(trigger);
  const registered2 = await mailbox.isRouted(id);
  expect(registered2).toBe(false);
  const allOpenDeliveries2 = await allOpenDeliveries(db.sql);
  expect(allOpenDeliveries2).toEqual([]);
  expect(mailbox.deliveriesOf(defaultOrchestrator)).toEqual([]);
  expect(core.state()).toBe(state);
});

test("regression: duplicate source and channel records keep the first trigger and payload", async () => {
  await using farm = await moduleWorld();
  const { mailbox } = farm;
  const first = await mailbox.recordTrigger(event);
  const triggerRecorded = await mailbox.recordTrigger({ ...event, text: "changed", data: null, at: 20 });
  expect(triggerRecorded).toEqual(first);
  expect((await mailbox.readTrigger(first.id))?.payload).toEqual({ text: event.text, data: event.data });
  const knownGitHubEvents2 = await mailbox.knownGitHubEvents("repo", 7);
  expect(knownGitHubEvents2).toEqual([{ key: event.key, routed: false, botRound: 1, botRoundKey: "round-1" }]);
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
  const { mailbox } = farm;
  const first = await mailbox.recordTrigger({ ...event, source: "cron", key: "first", data: { occurrence: 1 } });
  const second = await mailbox.recordTrigger({ ...event, source: "cron", key: "second", data: { occurrence: 2 } });
  const seen: unknown[] = [];
  await mailbox.replayCronTriggers(async (trigger, data) => void seen.push({ id: trigger.id, data }));
  expect(seen).toEqual([
    { id: first.id, data: { occurrence: 1 } },
    { id: second.id, data: { occurrence: 2 } },
  ]);
  const registered2 = await mailbox.isRouted(first.id);
  expect(registered2).toBe(false);
  const registered3 = await mailbox.isRouted(second.id);
  expect(registered3).toBe(false);
});
