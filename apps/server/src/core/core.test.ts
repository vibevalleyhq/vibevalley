import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { WorkspaceState, Session, StateFrame } from "@vibevalley/protocol";
import { Effect, Fiber, Layer, Logger, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { emptyProgress } from "../game/progress.ts";
import { Settings } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { layer as projection } from "../projection/projection.ts";
import { Core, emptyWorkspaceState, layer, stateEveryMs } from "./core.ts";
import { sessionId } from "@vibevalley/protocol/schema";

const helper: Session = { id: sessionId("w1"), name: "帮工", agent: "lab", runtime: "pi", brief: "写", hiredAt: 0, runs: 0, phase: { _tag: "done" } };

describe("core", () => {
  it.effect("started again from state.json: idle, without the database's parts, the sessions at their stations", () => {
    const config = testConfig();
    const was: WorkspaceState = {
      ...emptyWorkspaceState(),
      call: "live",
      callReason: "挂了",
      orchestrator: "speaking",
      orchestratorConversation: "c1",
      sessions: [helper],
      progress: emptyProgress(),
      recurrences: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    return Effect.gen(function* () {
      const s = (yield* Core).state();
      expect([s.call, s.callReason, s.orchestrator, s.orchestratorConversation]).toEqual(["idle", undefined, "idle", undefined]);
      expect([s.progress, s.recurrences, s.issues]).toEqual([undefined, undefined, undefined]);
      expect(s.sessions).toHaveLength(1);
      expect(s.sessions[0]!.play?.station).toBe(0);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config)))));
  });

  it.effect("valid JSON with the wrong state shape is kept aside untouched, and the farm starts empty", () => {
    const config = testConfig();
    const raw = JSON.stringify({ call: "idle", orchestrator: "idle", sessions: {} });
    writeFileSync(join(config.home, "state.json"), raw);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect((yield* Core).state()).toEqual(emptyWorkspaceState());
        }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config))))),
      );
      // Closing wrote a new state.json; the owner's old one is kept as it was.
      const kept = readdirSync(config.home).filter((f) => f.startsWith("state.json.unreadable-"));
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(config.home, kept[0]!), "utf8")).toBe(raw);
    });
  });

  it.effect("open reads the call state when its effect runs", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const core = yield* Core;
      yield* core.open();
      const reopen = core.open();
      yield* core.apply({ type: "call", state: "idle" });
      expect(core.state().call).toBe("idle");
      yield* reopen;
      expect(core.state().call).toBe("live");
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config)))));
  });

  it.effect("a fact is stamped and sent; the same again is no news; state.json is written on close, without the words", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const core = yield* Core;
          const seen = yield* core.events.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped);
          yield* TestClock.adjust(5);
          yield* core.apply({ type: "hired", session: { ...helper, phase: { _tag: "arriving" } } });
          yield* core.setOrchestrator("thinking");
          yield* core.setOrchestrator("thinking");
          yield* core.apply({ type: "progress", progress: emptyProgress() });
          yield* core.setCommits({ total: 1, today: 0, week: 0 } as never);
          const got = yield* Fiber.join(seen);
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

  it.effect("an internal subscriber keeps a whole burst while it works", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const incoming = yield* core.subscribe;
      const seen = yield* Effect.forkScoped(
        incoming.pipe(
          Stream.take(128),
          // On the TestClock: a reader slower than the burst, not a wait.
          // oxlint-disable-next-line vibevalley/no-test-sleep
          Stream.tap(() => Effect.sleep(1)),
          Stream.runCount,
        ),
      );
      yield* TestClock.adjust(5);
      for (let i = 0; i < 128; i++) yield* core.setOrchestrator(i % 2 === 0 ? "thinking" : "speaking");
      yield* TestClock.adjust(200);
      expect(yield* Fiber.join(seen)).toBe(128);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );

  it.effect("a delayed save failure is logged and the final save still works", () => {
    const config = testConfig();
    const messages: unknown[] = [];
    const logger = Logger.make((options) => {
      messages.push(options.message);
    });
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          mkdirSync(join(config.home, "state.json"));
          const core = yield* Core;
          yield* core.setOrchestrator("thinking");
          yield* TestClock.adjust(600);
          expect(messages.some((message) => String(message).includes("state.json could not be saved"))).toBe(true);
          rmSync(join(config.home, "state.json"), { recursive: true });
        }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, config))))),
      );
      expect(readFileSync(join(config.home, "state.json"), "utf8")).toContain("thinking");
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });

  it.effect("the orchestrator's state says where it thinks and writes, and forgets it once it listens", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* core.setOrchestrator("thinking", "c1");
      expect([core.state().orchestrator, core.state().orchestratorConversation]).toEqual(["thinking", "c1"]);
      yield* core.setOrchestrator("speaking", "c2");
      expect([core.state().orchestrator, core.state().orchestratorConversation]).toEqual(["speaking", "c2"]);
      yield* core.setOrchestrator("listening");
      expect(core.state().orchestrator).toBe("listening");
      expect("orchestratorConversation" in core.state()).toBe(false);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );

  it.effect("apply stays synchronous for oar callbacks", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* Effect.sync(() => Effect.runSync(core.apply({ type: "orchestrator", state: "thinking" })));
      expect(core.state().orchestrator).toBe("thinking");
    }).pipe(Effect.provide(layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(Settings, testConfig()))))),
  );
});
