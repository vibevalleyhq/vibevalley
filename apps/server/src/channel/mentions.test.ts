import { expect, it } from "@effect/vitest";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { Core } from "@/core/core.ts";
import { emptyPatrol, patrolStep } from "@/notice/patrol.ts";
import { frameOf } from "@/projection/frame.ts";
import { testConfig } from "@/testing/layers.ts";
import { world } from "@/testing/world.ts";
import { Channels } from "./chat.ts";

const mentionIds = (core: Core["Service"]) =>
  frameOf(core.state())
    .inbox.filter((item) => item.kind === "mention")
    .map((item) => item.id);

it.live("an unresolved owner mention survives both history windows and restart until read", () => {
  const config = testConfig({ db: "" });
  let thread = "";
  let message = "";
  let at = 0;
  let number = 0;
  const standing = Effect.gen(function* () {
    const core = yield* Core;
    expect(core.state().chat?.channels.some((c) => c.id === thread)).toBe(false);
    expect(mentionIds(core)).toEqual([message]);
    expect(patrolStep(core.state(), at + 16 * 60_000, emptyPatrol())[0].map((item) => item.key)).toEqual([message]);
  });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const chat = yield* Channels;
      const core = yield* Core;
      const parent = (yield* chat.say("需要确认的话题", undefined, "")).message;
      const written = (yield* chat.speak("orchestrator", "@主人 请确认这份变更", { target: `#general:${parent.number}`, anyway: true })).message!;
      ({ channel: thread, id: message, at, number } = written);
      expect(mentionIds(core)).toEqual([message]);
      for (let i = 0; i < 101; i++) {
        const other = (yield* chat.say(`其他话题 ${i}`, undefined, "")).message;
        const fresh = (yield* chat.speak("orchestrator", "其他答复", { target: `#general:${other.number}`, anyway: true })).message!.channel;
        yield* chat.notice(fresh, "动静一", "history");
        yield* chat.notice(fresh, "动静二", "history");
      }
      yield* standing;
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
    yield* Effect.gen(function* () {
      const chat = yield* Channels;
      const core = yield* Core;
      yield* standing;
      yield* chat.markRead(thread, number);
      expect(mentionIds(core)).toEqual([]);
      expect(patrolStep(core.state(), at + 16 * 60_000, emptyPatrol())[0]).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(config.home, { recursive: true, force: true }))));
});

it.live("only reading or replying in the mentioned channel completes an owner mention", () => {
  const config = testConfig();
  return Effect.gen(function* () {
    const chat = yield* Channels;
    const core = yield* Core;
    const channel = yield* chat.openChannel("review", "", "");
    const first = (yield* chat.speak("orchestrator", "@主人 第一份变更", { target: "#review", anyway: true })).message!;
    yield* chat.say("默认频道的另一件事", undefined, "");
    expect(mentionIds(core)).toEqual([first.id]);
    yield* chat.say("确认了", channel.id, "");
    expect(mentionIds(core)).toEqual([]);
    const second = (yield* chat.speak("orchestrator", "@主人 第二份变更", { target: "#review", anyway: true })).message!;
    expect(mentionIds(core)).toEqual([second.id]);
    yield* chat.markRead(channel.id, second.number);
    expect(mentionIds(core)).toEqual([]);
    const third = (yield* chat.speak("orchestrator", "@主人 第三份变更", { target: "#review", anyway: true })).message!;
    expect(mentionIds(core)).toEqual([third.id]);
    yield* chat.read("owner", { target: "#review" });
    expect(mentionIds(core)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(world({ config })), Effect.ensuring(Effect.sync(() => rmSync(config.home, { recursive: true, force: true }))));
});
