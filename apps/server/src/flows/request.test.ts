// What the page's retries rely on at the HTTP handlers: a request key does its work once, a reply's seq is shown by the
// frame at that seq, and a set sent twice is one change.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";

import type * as T from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { Channel } from "@/channel/chat.ts";
import { Connector } from "@/connector/connector.ts";
import { Core } from "@/core/core.ts";
import { handlers } from "@/handlers.ts";
import { Lan } from "@/lan/lan.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";
import { Voice } from "@/voice/voice.ts";

import { farm, lab } from "./farm.ts";

/** Used by none of these requests: a stand-in that throws if it is. */
const unused = (): never => {
  throw new Error("not a door these requests go through");
};

/** The farm's own services, and the doors these requests never go through as stand-ins that fail if they are used. */
const withDoors = (f: ReturnType<typeof farm>) =>
  Layer.mergeAll(
    Layer.mock(Orchestrator)({ answerer: unused }),
    Layer.mock(Lan)({ status: unused, stopPairing: unused, previewStopPairing: unused, setUpstream: unused }),
    Layer.mock(Voice)({ mossProblem: unused, lines: unused }),
    Layer.mock(Connector)({}),
  ).pipe(Layer.provideMerge(f.layer));

describe("a request the page may send again", () => {
  it.live("with the same key creates, moves, opens a thread and remembers once", () => {
    const f = farm();
    return Effect.gen(function* () {
      const h = yield* handlers;
      yield* (yield* Agent).save(lab());
      const before = (yield* h["issue.list"]({})).length;
      const made = yield* h["issue.create"]({ title: "只写一次", requestKey: "create-1" });
      const again = yield* h["issue.create"]({ title: "只写一次", requestKey: "create-1" });
      expect(again).toEqual(made);
      expect((yield* h["issue.list"]({})).length).toBe(before + 1);

      // Without the key a second cancel is refused (the issue is closed); with it, the first answer comes back.
      const moved = yield* h["issue.status.update"]({ id: made.id, status: "canceled", requestKey: "move-1" });
      expect(moved.status).toBe("canceled");
      expect(yield* h["issue.status.update"]({ id: made.id, status: "canceled", requestKey: "move-1" })).toEqual(moved);
      expect(yield* Effect.flip(h["issue.status.update"]({ id: made.id, status: "canceled" }))).toMatchObject({ _tag: "Refused" });

      const said = (yield* (yield* Channel).say("开个串", undefined, "")).message;
      const thread = yield* h["channel.thread.create"]({ id: said.id, requestKey: "thread-1" });
      expect(yield* h["channel.thread.create"]({ id: said.id, requestKey: "thread-1" })).toBe(thread);

      const kept = yield* h["memory.create"]({ agent: "lab", text: "打卡页用中文", requestKey: "memory-1" });
      expect(yield* h["memory.create"]({ agent: "lab", text: "打卡页用中文", requestKey: "memory-1" })).toEqual(kept);
      expect((yield* h["memory.list"]({ agent: "lab" })).memories.filter((m) => m.text === "打卡页用中文")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(withDoors(f)));
  });

  it.live("answers with a seq that the first frame at least that far shows", () => {
    const f = farm();
    return Effect.gen(function* () {
      const h = yield* handlers;
      const core = yield* Core;
      const frames = yield* Queue.unbounded<T.StateFrame>();
      yield* core.states.pipe(
        Stream.runForEach((frame) => Queue.offer(frames, frame)),
        Effect.forkScoped,
      );
      const made = yield* h["issue.create"]({ title: "看帧" });
      const moved = yield* h["issue.status.update"]({ id: made.id, status: "canceled" });
      expect(moved.seq).toBeGreaterThan(made.seq);
      let frame = yield* Queue.take(frames);
      while (frame.seq < moved.seq) frame = yield* Queue.take(frames);
      expect(frame.state.issues.find((i) => i.id === made.id)?.status).toBe("canceled");
    }).pipe(Effect.scoped, Effect.provide(withDoors(f)));
  });

  it.live("set twice is one change", () => {
    const f = farm();
    return Effect.gen(function* () {
      const h = yield* handlers;
      const said = (yield* (yield* Channel).say("点个赞", undefined, "")).message;
      const liked = yield* h["channel.reaction.set"]({ id: said.id, emoji: "👍", on: true });
      const again = yield* h["channel.reaction.set"]({ id: said.id, emoji: "👍", on: true });
      expect([again.reactions, again.revision]).toEqual([liked.reactions, liked.revision]);
      const pinned = yield* h["channel.pin.set"]({ id: said.id, on: true });
      expect((yield* h["channel.pin.set"]({ id: said.id, on: true })).revision).toBe(pinned.revision);
      const channel = yield* h["channel.create"]({ name: "收起来" });
      yield* h["channel.archive.set"]({ id: channel, on: true });
      const archived = (yield* h["channel.list"]()).find((c) => c.id === channel)?.archived;
      expect(archived).toBeDefined();
      yield* h["channel.archive.set"]({ id: channel, on: true });
      expect((yield* h["channel.list"]()).find((c) => c.id === channel)?.archived).toBe(archived);
    }).pipe(Effect.scoped, Effect.provide(withDoors(f)));
  });
});
