import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { moduleWorld } from "#/testing/world.ts";
import * as cursor from "#db/issue_github.sql.ts";
import { allOpenDeliveries } from "#db/mailbox_delivery.sql.ts";

import { Mailbox } from "./mailbox.ts";
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

it.effect("regression: the source cursor and Mailbox trigger share commit and rollback without routing", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const db = yield* Db;
    const core = yield* Core;
    const state = core.state();
    const scope = { repo: "repo", pr_number: 7 };
    const id = triggerOf(event).id;
    yield* db.run(cursor.ensureGitHubCursor(scope));
    const write = Effect.gen(function* () {
      yield* db.run(cursor.observeGitHubChecks({ ...scope, check_fingerprint: "changed", check_revision: 1 }));
      return yield* mailbox.recordTrigger(event);
    });
    const rolledBack = yield* Effect.exit(db.inTx(Effect.andThen(write, Effect.fail("rollback"))));
    expect(Exit.isFailure(rolledBack)).toBe(true);
    const trigger2 = yield* mailbox.readTrigger(id);
    expect(trigger2).toBeUndefined();
    expect((yield* db.run(cursor.gitHubCursor(scope))).check_revision).toBe(0);
    const trigger = yield* db.inTx(write);
    expect((yield* db.run(cursor.gitHubCursor(scope))).check_revision).toBe(1);
    expect((yield* mailbox.readTrigger(id))?.trigger).toEqual(trigger);
    const registered2 = yield* mailbox.isRouted(id);
    expect(registered2).toBe(false);
    const allOpenDeliveries2 = yield* db.run(allOpenDeliveries());
    expect(allOpenDeliveries2).toEqual([]);
    expect(mailbox.deliveriesOf(defaultOrchestrator)).toEqual([]);
    expect(core.state()).toBe(state);
  }).pipe(Effect.scoped, Effect.provide(moduleWorld())),
);

it.effect("regression: duplicate source and channel records keep the first trigger and payload", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const first = yield* mailbox.recordTrigger(event);
    const triggerRecorded = yield* mailbox.recordTrigger({ ...event, text: "changed", data: null, at: 20 });
    expect(triggerRecorded).toEqual(first);
    expect((yield* mailbox.readTrigger(first.id))?.payload).toEqual({ text: event.text, data: event.data });
    const knownGitHubEvents2 = yield* mailbox.knownGitHubEvents("repo", 7);
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
    const channelTriggerRecorded = yield* mailbox.recordTrigger(message);
    expect(channelTriggerRecorded).toEqual(channel);
    const channelTriggerRecorded2 = yield* mailbox.recordTrigger({
      ...message,
      at: 20,
      text: "changed",
      data: { kind: "channel_message", message: "message", channel: "other" },
    });
    expect(channelTriggerRecorded2).toEqual(channel);
    expect((yield* mailbox.readTrigger(channel.id))?.payload).toEqual({
      text: "first",
      data: { kind: "channel_message", message: channel.id, channel: "room" },
    });
  }).pipe(Effect.scoped, Effect.provide(moduleWorld())),
);

it.effect("regression: cron replay supplies decoded source payloads without routing them", () =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const first = yield* mailbox.recordTrigger({ ...event, source: "cron", key: "first", data: { occurrence: 1 } });
    const second = yield* mailbox.recordTrigger({ ...event, source: "cron", key: "second", data: { occurrence: 2 } });
    const seen: unknown[] = [];
    yield* mailbox.replayCronTriggers((trigger, data) => Effect.sync(() => void seen.push({ id: trigger.id, data })));
    expect(seen).toEqual([
      { id: first.id, data: { occurrence: 1 } },
      { id: second.id, data: { occurrence: 2 } },
    ]);
    const registered2 = yield* mailbox.isRouted(first.id);
    expect(registered2).toBe(false);
    const registered3 = yield* mailbox.isRouted(second.id);
    expect(registered3).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(moduleWorld())),
);
