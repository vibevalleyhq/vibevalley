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
    const agent = chat.orchestratorOf(channel);
    yield* chat.orchestratorSays(channel, "需要你确认", "read-receipt", agent);
    const message = (yield* chat.history(channel)).at(-1)!;
    expect(yield* inbox.handoffState(message.id)).toBe("unseen");
    yield* chat.markRead(channel, message.number);
    expect(yield* inbox.handoffState(message.id)).toBe("seen");
    yield* chat.say("确认", channel, "owner-reply");
    expect(yield* inbox.handoffState(message.id)).toBeUndefined();
    yield* chat.orchestratorSays(channel, "又有一项变化", "incremental-update", agent);
    const update = (yield* chat.history(channel)).at(-1)!;
    expect(yield* inbox.handoffState(update.id)).toBe("unseen");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
