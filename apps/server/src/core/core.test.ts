import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { WorkspaceState, Session, SideEvent, StateFrame } from "@vibevalley/protocol";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { emptyProgress } from "../game/progress.ts";
import { Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { layer as projection } from "../projection/projection.ts";
import { Core, emptyWorkspaceState, layer, stateEveryMs } from "./core.ts";

const helper: Session = { id: "w1", name: "帮工", agent: "lab", runtime: "pi", brief: "写", hiredAt: 0, runs: 0, phase: { _tag: "done" } };

describe("core", () => {
  it.effect("started again from state.json: idle, without the database's parts, the sessions at their stations", () => {
    const config = testConfig();
    const was: WorkspaceState = {
      ...emptyWorkspaceState(),
      call: "live",
      callReason: "挂了",
      orchestrator: "speaking",
      sessions: [helper],
      progress: emptyProgress(),
      recurrences: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    return Effect.gen(function* () {
      const s = (yield* Core).state();
      expect([s.call, s.callReason, s.orchestrator]).toEqual(["idle", undefined, "idle"]);
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
          yield* core.setOrchestrator("thinking");
          yield* core.setOrchestrator("thinking");
          yield* core.apply({ type: "progress", progress: emptyProgress() });
          yield* core.setCommits({ total: 1, today: 0, week: 0 } as never);
          const got = (yield* Fiber.join(seen)) as SideEvent[];
          expect(got.map((e) => e.type)).toEqual(["snapshot", "hired", "orchestrator", "progress"]);
          expect(got[2]!.at).toBeGreaterThan(0);
        }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config))))),
      );
      const kept = JSON.parse(readFileSync(join(config.home, "state.json"), "utf8")) as Record<string, unknown>;
      expect(kept.orchestrator).toBe("thinking");
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
      expect((yield* Queue.take(frames)).state.orchestrator).toBe("idle");
      yield* core.setOrchestrator("speaking");
      yield* core.setCommits({ total: 2 } as never);
      yield* TestClock.adjust(stateEveryMs);
      const next = yield* Queue.take(frames);
      expect([next.state.orchestrator, next.state.commits?.total]).toEqual(["speaking", 2]);
      yield* TestClock.adjust(stateEveryMs * 2);
      expect(yield* Queue.size(frames)).toBe(0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );

  it.effect("an interrupted publish still commits every channel in order", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const updated = yield* Deferred.make<void>();
      const moved = yield* Deferred.make<void>();
      const totals: number[] = [];
      const updates: number[] = [];
      const transitions: number[] = [];
      yield* core.events.pipe(
        Stream.runForEach((e) => {
          if (e.type === "snapshot") return Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release)));
          if (e.type !== "commits") return Effect.void;
          return Effect.gen(function* () {
            totals.push(e.commits.total);
            if (e.commits.total === 64) yield* Deferred.succeed(drained, undefined);
          });
        }),
        Effect.forkScoped,
      );
      const subscribed = yield* core.subscribe;
      yield* subscribed.pipe(
        Stream.runForEach((e) =>
          Effect.gen(function* () {
            if (e.type !== "commits") return;
            updates.push(e.commits.total);
            if (e.commits.total === 64) yield* Deferred.succeed(updated, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      const [, moves] = yield* core.transitions;
      yield* moves.pipe(
        Stream.runForEach((t) =>
          Effect.gen(function* () {
            if (t.fact.type !== "commits") return;
            transitions.push(t.fact.commits.total);
            if (t.fact.commits.total === 64) yield* Deferred.succeed(moved, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(reading);
      for (let total = 0; total < 64; total++) yield* core.setCommits({ total } as never);
      let finished = false;
      const pending = yield* Effect.forkChild(core.setCommits({ total: 64 } as never).pipe(Effect.tap(() => Effect.sync(() => void (finished = true)))), {
        startImmediately: true,
      });
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(pending), { startImmediately: true });
      yield* Effect.yieldNow;
      expect(finished).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      yield* Deferred.await(drained);
      yield* Deferred.await(updated);
      yield* Deferred.await(moved);
      const expected = Array.from({ length: 65 }, (_, total) => total);
      expect(totals).toEqual(expected);
      expect(updates).toEqual(expected);
      expect(transitions).toEqual(expected);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );

  it.effect("a slow frame reader bounds each burst and catches up with the latest state", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latest = yield* Deferred.make<void>();
      const totals: Array<number | undefined> = [];
      let first = true;
      yield* core.states.pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            if (first) {
              first = false;
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(release);
            }
            const total = frame.state.commits?.total;
            totals.push(total);
            if (total === 31) yield* Deferred.succeed(latest, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(reading);
      // One change is already in the frame window; the next publish waits for the bounded subscription.
      for (let total = 0; total < 31; total++) yield* core.setCommits({ total } as never);
      let finished = false;
      const pending = yield* Effect.forkChild(core.setCommits({ total: 31 } as never).pipe(Effect.tap(() => Effect.sync(() => void (finished = true)))), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      expect(finished).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust(stateEveryMs);
      yield* Fiber.join(pending);
      yield* Deferred.await(latest);
      expect(finished).toBe(true);
      expect(totals).toEqual([undefined, 31]);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );
});
