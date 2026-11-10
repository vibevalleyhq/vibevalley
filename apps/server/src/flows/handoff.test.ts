import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Channel } from "#/channel/channel.ts";
import { Inbox } from "#/inbox/inbox.ts";

import { farm } from "./farm.ts";

it.effect("regression: user read cursors and later replies suppress external notifications", () => {
  const f = farm();
  return Effect.gen(function* () {
    const chat = yield* Channel;
    const inbox = yield* Inbox;
    const channel = chat.defaultChannel();
    const agent = chat.orchestratorIn(channel);
    yield* chat.post({ _tag: "Run", from: agent, channel: channel, text: "需要你确认", run: "read-receipt" });
    const message = (yield* chat.history(channel)).at(-1)!;
    const handoffState2 = yield* inbox.handoffState(message.id);
    expect(handoffState2).toBe("unseen");
    yield* chat.markRead(channel, message.number);
    const handoffState3 = yield* inbox.handoffState(message.id);
    expect(handoffState3).toBe("seen");
    yield* chat.post({ _tag: "User", text: "确认", channel: channel, sendKey: "user-reply" });
    const handoffState4 = yield* inbox.handoffState(message.id);
    expect(handoffState4).toBeUndefined();
    yield* chat.post({ _tag: "Run", from: agent, channel: channel, text: "又有一项变化", run: "incremental-update" });
    const update = (yield* chat.history(channel)).at(-1)!;
    const handoffState5 = yield* inbox.handoffState(update.id);
    expect(handoffState5).toBe("unseen");
  }).pipe(Effect.scoped, Effect.provide(f.layer));
});
