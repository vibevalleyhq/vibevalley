import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { CoreState, Session, SideEvent, StateFrame } from "@vibevalley/protocol";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { emptyProgress } from "../game/progress.ts";
import { Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { layer as projection } from "../projection/projection.ts";
import { Core, emptyCoreState, layer, stateEveryMs } from "./core.ts";

const helper: Session = { id: "w1", name: "帮工", agent: "lab", runtime: "pi", brief: "写", hiredAt: 0, runs: 0, phase: { _tag: "ripe" } };

describe("core", () => {
  it.effect("started again from state.json: idle, without the database's parts, the sessions at their stations", () => {
    const config = testConfig();
    const was: CoreState = {
      ...emptyCoreState(),
      call: "live",
      callReason: "挂了",
      manager: "speaking",
      sessions: [helper],
      progress: emptyProgress(),
      recurrences: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    return Effect.gen(function* () {
      const s = (yield* Core).state();
      expect([s.call, s.callReason, s.manager]).toEqual(["idle", undefined, "idle"]);
      expect([s.progress, s.recurrences, s.issues]).toEqual([undefined, undefined, undefined]);
      expect(s.sessions).toHaveLength(1);
      expect(s.sessions[0]!.play?.station).toBe(0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config)))));
  });

  it.effect("a fact is stamped and sent; the same again is no news; state.json is written on close, without the words", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const core = yield* Core;
          const seen = yield* core.events.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* core.apply({ type: "hired", session: { ...helper, phase: { _tag: "arriving" } } });
          yield* core.setManager("thinking");
          yield* core.setManager("thinking");
          yield* core.apply({ type: "progress", progress: emptyProgress() });
          yield* core.setCommits({ total: 1, today: 0, week: 0 } as never);
          const got = (yield* Fiber.join(seen)) as SideEvent[];
          expect(got.map((e) => e.type)).toEqual(["snapshot", "hired", "manager", "progress"]);
          expect(got[2]!.at).toBeGreaterThan(0);
        }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config))))),
      );
      const kept = JSON.parse(readFileSync(join(config.home, "state.json"), "utf8")) as Record<string, unknown>;
      expect(kept.manager).toBe("thinking");
      expect(kept.progress).toBeUndefined();
      expect(JSON.stringify(kept)).not.toMatch(/phaseText|whenText/);
    });
  });

  it.effect("a burst of facts is one frame", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const frames = yield* Queue.unbounded<StateFrame>();
      yield* core.states.pipe(
        Stream.runForEach((f) => Queue.offer(frames, f)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(frames)).state.manager).toBe("idle");
      yield* core.setManager("speaking");
      yield* core.setCommits({ total: 2 } as never);
      yield* TestClock.adjust(stateEveryMs);
      const next = yield* Queue.take(frames);
      expect([next.state.manager, next.state.commits?.total]).toEqual(["speaking", 2]);
      yield* TestClock.adjust(stateEveryMs * 2);
      expect(yield* Queue.size(frames)).toBe(0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );
});
