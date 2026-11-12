import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { type SourceEvent } from "#/modules/session/mailbox.ts";
import { committedDelivery } from "#/testing/deliveries.ts";
import { testIssues } from "#/testing/world.ts";

import { farm, lab, until } from "./farm.ts";

const signal = (key: string, kind: "user" | "agent" = "agent", threads: readonly string[] = [], at = 0): SourceEvent => ({
  source: "channel",
  key,
  actor: kind === "user" ? { kind: "user", id: "user" } : { kind: "agent", id: "other-session", role: "worker" },
  addressed: "mention",
  threads,
  text: key,
  at,
});

test("regression: concurrent mailbox writes and restoration leave every committed input in the cache", async () => {
  const f = farm();
  await using fw = await f.open();
  const mailbox = fw.inside;
  const channel = fw.channel.defaultChannel();
  const recorded = [];
  for (let n = 0; n < 12; n++) recorded.push(await mailbox.record(signal(`concurrent-${n}`)));
  const inputs = recorded.filter((input) => input !== undefined);
  const writes = inputs.map((trigger) =>
    committedDelivery(fw.db, {
      session: defaultOrchestrator,
      row: {
        envelope_id: trigger.id,
        scope: `channel:${channel}`,
        message_id: null,
        channel_id: channel,
        source: trigger.source,
        urgency: "digest",
        reason: "channel",
        wakes: false,
        held_by: null,
        state: "pending",
        launch: null,
        created_at: 1,
        payload: { trigger, context: { number: 0, target: trigger.card.readUri }, channelType: "channel" },
      },
    }),
  );
  await Promise.all([...writes, mailbox.restoreDeliveries(), mailbox.restoreDeliveries()]);
  expect(
    mailbox
      .deliveriesOf(defaultOrchestrator)
      .map((row) => row.envelope_id)
      .toSorted(),
  ).toEqual(inputs.map((input) => input.id).toSorted());
});

test("regression: independent input hops survive restore and only a new user receipt resets them", async () => {
  const f = farm();
  await using fw = await f.open();
  const mailbox = fw.inside;
  const accept = (key: string, kind: "user" | "agent" = "agent") => mailbox.accept(signal(key, kind));
  for (const n of [1, 2, 3, 4, 5]) await accept(`before-user-${n}`);
  const rows = () => mailbox.deliveriesOf(defaultOrchestrator);
  expect(rows().map((row) => row.held_by)).toEqual([null, null, null, null, "hop_limit"]);
  await mailbox.restoreDeliveries();
  const blocked = (await accept("after-restore"))!;
  expect(rows().find((row) => row.envelope_id === blocked.id)?.held_by).toBe("hop_limit");
  await accept("user-receipt", "user");
  const next = (await accept("after-user-1"))!;
  expect(rows().find((row) => row.envelope_id === next.id)?.held_by).toBeNull();
  await accept("user-receipt", "user");
  await mailbox.restoreDeliveries();
  for (const n of [2, 3, 4]) await accept(`after-user-${n}`);
  const capped = (await accept("after-user-5"))!;
  expect(rows().find((row) => row.envelope_id === capped.id)?.held_by).toBe("hop_limit");
});

test("regression: queued triggers enter the first model request in receipt order despite source clock changes", async () => {
  const inputs: string[] = [];
  const f = farm({
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        turn.say("finished");
      },
    }),
  });
  await using fw = await f.open();
  const issue2 = fw.issue;
  const issues = testIssues(issue2);
  const mailbox = fw.inside;
  await fw.agent.save(lab());
  const issue = await issues.add({ title: "work", agent: "lab", repo: "fifo" });
  const markers = ["FIFO_FIRST_CARD", "FIFO_SECOND_CARD", "FIFO_THIRD_CARD"];
  for (const [index, text] of markers.entries())
    await mailbox.record({
      source: "github",
      key: text,
      actor: { kind: "system", id: "checks" },
      addressed: "thread_owner",
      threads: [`issue:${issue.id}`],
      text,
      at: [500, 1, 500][index]!,
      meta: { kind: "ci", failed: true },
    });
  await mailbox.replay();
  await issues.start(issue.id, "");
  await until(() => inputs.length === 1, "the queued batch in the initial request");
  const positions = markers.map((marker) => inputs[0]!.indexOf(marker));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
});

test("regression: an independent agent wake restores cooldown using receipt time rather than the source clock", async () => {
  const gate = Promise.withResolvers<void>();
  const turns: string[] = [];
  let steers = (): readonly string[] => [];
  const f = farm({
    change: (config) => ({ ...config, chat: { ...config.chat, noticeBatchMs: 1 } }),
    runtime: scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns.push(turn.input);
        steers = () => turn.steered;
        await gate.promise;
      },
    }),
  });
  await using fw = await f.open();
  try {
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const mailbox = fw.inside;
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "work", agent: "lab", repo: "cooldown" });
    const started = await issues.start(issue.id, "");
    const threads = [`issue:${issue.id}`];
    const first = (await mailbox.accept(signal("first-wake", "agent", threads)))!;
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === first.id)?.held_by).toBeNull();
    await until(
      () => steers().some((text) => text.includes("first-wake")) && !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === first.id),
      "the first agent input consumed",
    );
    await mailbox.restoreDeliveries();
    const second = (await mailbox.accept(signal("future-source-clock", "agent", threads, 9_000_000_000_000)))!;
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === second.id)?.held_by).toBe("cooldown");
    const queued = (await mailbox.accept({
      source: "github",
      key: "queued-ci",
      actor: { kind: "system", id: "checks" },
      addressed: "thread_owner",
      threads,
      text: "queued-ci",
      at: 0,
      meta: { kind: "ci", failed: true },
    }))!;
    await mailbox.accept(signal("user-authorized-wave", "user", threads));
    await until(() => !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === second.id), "the held card consumed with a user steer");
    expect(steers().some((text) => text.includes("future-source-clock") && text.includes("user-authorized-wave"))).toBe(true);
    expect(steers().some((text) => text.includes("queued-ci"))).toBe(false);
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === queued.id)?.state).toBe("pending");
    const sessions = fw.inside;
    gate.resolve();
    await until(() => sessions.sessionOf(started.session!)?.phase._tag === "done", "the original turn ended");
    await mailbox.accept(signal("user-next-run", "user", threads));
    await until(() => turns.length === 2, "a new turn takes the queued input");
    expect(turns[1]).toContain("queued-ci");
  } finally {
    gate.resolve();
  }
});
