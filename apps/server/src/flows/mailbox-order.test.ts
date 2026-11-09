import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { Channel } from "#/channel/channel.ts";
import { Ingress, type SourceEvent } from "#/ingress/ingress.ts";
import { Issue } from "#/issue/issue.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import { committedDelivery } from "#/testing/deliveries.ts";
import { testIssues } from "#/testing/world.ts";

import { farm, lab, until } from "./farm.ts";

const signal = (key: string, kind: "owner" | "agent" = "agent", threads: readonly string[] = [], at = 0): SourceEvent => ({
  source: "channel",
  key,
  actor: { kind, id: kind === "owner" ? "owner" : "other-session" },
  addressed: "mention",
  threads,
  text: key,
  at,
});

it.live("regression: concurrent mailbox writes and restoration leave every committed input in the cache", () => {
  const f = farm();
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const ingress = yield* Ingress;
    const channel = (yield* Channel).defaultChannel();
    const inputs = (yield* Effect.forEach(
      Array.from({ length: 12 }, (_, n) => n),
      (n) => ingress.record(signal(`concurrent-${n}`)),
    )).filter((input) => input !== undefined);
    const writes = inputs.map((trigger) =>
      committedDelivery({
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
    yield* Effect.all([...writes, mailbox.restore, mailbox.restore], { concurrency: "unbounded", discard: true });
    expect(
      mailbox
        .deliveriesOf(defaultOrchestrator)
        .map((row) => row.envelope_id)
        .toSorted(),
    ).toEqual(inputs.map((input) => input.id).toSorted());
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: independent input hops survive restore and only a new owner receipt resets them", () => {
  const f = farm();
  return Effect.gen(function* () {
    const ingress = yield* Ingress;
    const mailbox = yield* Mailbox;
    const accept = (key: string, kind: "owner" | "agent" = "agent") => ingress.accept(signal(key, kind));
    for (const n of [1, 2, 3, 4, 5]) yield* accept(`before-owner-${n}`);
    const rows = () => mailbox.deliveriesOf(defaultOrchestrator);
    expect(rows().map((row) => row.held_by)).toEqual([null, null, null, null, "hop_limit"]);
    yield* mailbox.restore;
    const blocked = (yield* accept("after-restore"))!;
    expect(rows().find((row) => row.envelope_id === blocked.id)?.held_by).toBe("hop_limit");
    yield* accept("owner-receipt", "owner");
    const next = (yield* accept("after-owner-1"))!;
    expect(rows().find((row) => row.envelope_id === next.id)?.held_by).toBeNull();
    yield* accept("owner-receipt", "owner");
    yield* mailbox.restore;
    for (const n of [2, 3, 4]) yield* accept(`after-owner-${n}`);
    const capped = (yield* accept("after-owner-5"))!;
    expect(rows().find((row) => row.envelope_id === capped.id)?.held_by).toBe("hop_limit");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: queued triggers enter the first model request in receipt order despite source clock changes", () => {
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
  return Effect.gen(function* () {
    const issue2 = yield* Issue;
    const issues = testIssues(issue2);
    const ingress = yield* Ingress;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "work", agent: "lab", repo: "fifo" });
    const markers = ["FIFO_FIRST_CARD", "FIFO_SECOND_CARD", "FIFO_THIRD_CARD"];
    for (const [index, text] of markers.entries())
      yield* ingress.record({
        source: "github",
        key: text,
        actor: { kind: "ci", id: "checks" },
        addressed: "thread_owner",
        threads: [`issue:${issue.id}`],
        text,
        at: [500, 1, 500][index]!,
        meta: { kind: "ci", failed: true },
      });
    yield* (yield* Mailbox).replay;
    yield* issues.start(issue.id, "");
    yield* until(() => inputs.length === 1, "the queued batch in the initial request");
    const positions = markers.map((marker) => inputs[0]!.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});

it.live("regression: an independent agent wake restores cooldown using receipt time rather than the source clock", () => {
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
  return Effect.gen(function* () {
    const issue2 = yield* Issue;
    const issues = testIssues(issue2);
    const mailbox = yield* Mailbox;
    const ingress = yield* Ingress;
    yield* (yield* Agent).save(lab());
    const issue = yield* issues.add({ title: "work", agent: "lab", repo: "cooldown" });
    const started = yield* issues.start(issue.id, "");
    const threads = [`issue:${issue.id}`];
    const first = (yield* ingress.accept(signal("first-wake", "agent", threads)))!;
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === first.id)?.held_by).toBeNull();
    yield* until(
      () => steers().some((text) => text.includes("first-wake")) && !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === first.id),
      "the first agent input consumed",
    );
    yield* mailbox.restore;
    const second = (yield* ingress.accept(signal("future-source-clock", "agent", threads, 9_000_000_000_000)))!;
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === second.id)?.held_by).toBe("cooldown");
    const queued = (yield* ingress.accept({
      source: "github",
      key: "queued-ci",
      actor: { kind: "ci", id: "checks" },
      addressed: "thread_owner",
      threads,
      text: "queued-ci",
      at: 0,
      meta: { kind: "ci", failed: true },
    }))!;
    yield* ingress.accept(signal("owner-authorized-wave", "owner", threads));
    yield* until(() => !mailbox.deliveriesOf(started.session!).some((row) => row.envelope_id === second.id), "the held card consumed with an owner steer");
    expect(steers().some((text) => text.includes("future-source-clock") && text.includes("owner-authorized-wave"))).toBe(true);
    expect(steers().some((text) => text.includes("queued-ci"))).toBe(false);
    expect(mailbox.deliveriesOf(started.session!).find((row) => row.envelope_id === queued.id)?.state).toBe("pending");
    const sessions = yield* Session;
    gate.resolve();
    yield* until(() => sessions.sessionOf(started.session!)?.phase._tag === "done", "the original turn ended");
    yield* ingress.accept(signal("owner-next-run", "owner", threads));
    yield* until(() => turns.length === 2, "a new turn takes the queued input");
    expect(turns[1]).toContain("queued-ci");
  }).pipe(Effect.ensuring(Effect.sync(gate.resolve)), Effect.scoped, Effect.provide(f.layer));
});
