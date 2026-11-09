import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Channel } from "#/channel/channel.ts";
import { Inbox } from "#/inbox/inbox.ts";

import { farm } from "./farm.ts";

it.effect("regression: owner read cursors and later replies suppress external notifications", () => {
  const f = farm();
  return Effect.gen(function* () {
    const chat = yield* Channel;
    const inbox = yield* Inbox;
    const channel = chat.defaultChannel();
    const agent = chat.orchestratorIn(channel);
    yield* chat.runSays(channel, "需要你确认", "read-receipt", agent);
    const message = (yield* chat.history(channel)).at(-1)!;
    const handoffState2 = yield* inbox.handoffState(message.id);
    expect(handoffState2).toBe("unseen");
    yield* chat.markRead(channel, message.number);
    const handoffState3 = yield* inbox.handoffState(message.id);
    expect(handoffState3).toBe("seen");
    yield* chat.say("确认", channel, "owner-reply");
    const handoffState4 = yield* inbox.handoffState(message.id);
    expect(handoffState4).toBeUndefined();
    yield* chat.runSays(channel, "又有一项变化", "incremental-update", agent);
    const update = (yield* chat.history(channel)).at(-1)!;
    const handoffState5 = yield* inbox.handoffState(update.id);
    expect(handoffState5).toBe("unseen");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
