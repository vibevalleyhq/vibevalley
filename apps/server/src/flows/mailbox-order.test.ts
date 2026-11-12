import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { type SourceEvent } from "#/modules/session/mailbox.ts";
import { committedDelivery } from "#/testing/deliveries.ts";
import { testConfig } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";
import { testIssues } from "#/testing/world.ts";

import { farm, type FlowWorld, lab, until } from "./farm.ts";

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
  // The hops are the watch's (watch/brakes.ts): an agent's words in a place wake the orchestrator, the user's start the
  // count over, and a restart reads them back from the deliveries kept.
  const f = farm({ config: testConfig({ db: "" }) });
  const held = async (fw: FlowWorld, id: string) =>
    (await sqlOf(fw.db).unsafe(`select held_by from session_delivery where session_id = $1 and envelope_id = $2`, [defaultOrchestrator, id]))[0]?.["held_by"] ??
    null;
  const call = async (fw: FlowWorld, text: string) => (await fw.channel.speak({ from: "w90", text: `@助手 ${text}`, anyway: true })).message!.id;
  const userSays = (fw: FlowWorld, sendKey: string) => fw.channel.say({ text: "听我说", sendKey });
  {
    await using fw = await f.open();
    await fw.channel.seat({ id: "w90", name: "别处的帮工", agent: "lab" });
    const before: unknown[] = [];
    for (const n of [1, 2, 3, 4, 5]) before.push(await held(fw, await call(fw, `before-user-${n}`)));
    expect(before).toEqual([null, null, null, null, "hop_limit"]);
  }
  {
    await using fw = await f.open();
    expect(await held(fw, await call(fw, "after-restore"))).toBe("hop_limit");
    await userSays(fw, "user-receipt");
    expect(await held(fw, await call(fw, "after-user-1"))).toBeNull();
    // The same send again is the same message: no new receipt, the count goes on.
    expect((await userSays(fw, "user-receipt")).again).toBe(true);
  }
  {
    await using fw = await f.open();
    for (const n of [2, 3, 4]) expect(await held(fw, await call(fw, `after-user-${n}`))).toBeNull();
    expect(await held(fw, await call(fw, "after-user-5"))).toBe("hop_limit");
  }
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
  // The cooldown is the watch's: it reads the time a delivery was kept (the restart's agentWakes), never a trigger's own.
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
    const thread = await fw.channel.issueThread(issue.id, issue.title);
    const { target } = await fw.channel.addressOf(thread);
    await fw.channel.seat({ id: "w90", name: "别处的帮工", agent: "lab" });
    const call = async (text: string) => (await fw.channel.speak({ from: "w90", text: `@${started.session!} ${text}`, target, anyway: true })).message!;
    const first = await call("first-wake");
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === first.id)?.held_by).toBeNull();
    await until(
      () => steers().some((text) => text.includes("first-wake")) && !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === first.id),
      "the first agent input consumed",
    );
    // Startup again: the brakes start from what the deliveries kept.
    await fw.watch.boot();
    const second = await call("future-source-clock");
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
    await fw.channel.say({ text: "user-authorized-wave", channel: thread, sendKey: "" });
    await until(() => !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === second.id), "the held card consumed with a user steer");
    expect(steers().some((text) => text.includes("future-source-clock") && text.includes("user-authorized-wave"))).toBe(true);
    expect(steers().some((text) => text.includes("queued-ci"))).toBe(false);
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === queued.id)?.state).toBe("pending");
    const sessions = fw.inside;
    gate.resolve();
    await until(() => sessions.sessionOf(started.session!)?.phase._tag === "done", "the original turn ended");
    await fw.channel.say({ text: "user-next-run", channel: thread, sendKey: "" });
    await until(() => turns.length === 2, "a new turn takes the queued input");
    expect(turns[1]).toContain("queued-ci");
  } finally {
    gate.resolve();
  }
});
