import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { WorkspaceState, Session, StateFrame } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { ServerConfig } from "@/base/config.ts";
import { emptyProgress } from "@/game/progress.ts";
import { layer as projection } from "@/projection/projection.ts";
import { testConfig } from "@/testing/layers.ts";

import { Core, emptyWorkspaceState, stateEveryMs } from "./core.ts";

const helper: Session = {
  id: sessionId("w1"),
  name: "帮工",
  agent: "lab",
  runtime: "pi",
  brief: "写",
  hiredAt: 0,
  runs: 0,
  phase: { _tag: "done" },
  refining: false,
};

describe("core", () => {
  it.effect("started again from state.json: idle, without the database's parts, the sessions at their stations", () => {
    const config = testConfig();
    const was: WorkspaceState = {
      ...emptyWorkspaceState(),
      call: "live",
      callReason: "挂了",
      orchestrators: { orchestrator: { state: "speaking", channel: "c1" } },
      sessions: [helper],
      progress: emptyProgress(),
      crons: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    return Effect.gen(function* () {
      const s = (yield* Core).state();
      expect([s.call, s.callReason, s.orchestrators]).toEqual(["idle", "", {}]);
      expect([s.progress, s.crons, s.issues]).toEqual([undefined, [], []]);
      expect(s.sessions).toHaveLength(1);
      expect(s.sessions[0]!.play?.station).toBe(0);
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)))));
  });

  it.effect("valid JSON with the wrong state shape is kept aside untouched, and the farm starts empty", () => {
    const config = testConfig();
    const raw = JSON.stringify({ call: "idle", orchestrators: {}, sessions: {} });
    writeFileSync(join(config.home, "state.json"), raw);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect((yield* Core).state()).toEqual(emptyWorkspaceState());
        }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config))))),
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
      yield* core.apply({ type: "call", state: "idle", reason: "" });
      expect(core.state().call).toBe("idle");
      yield* reopen;
      expect(core.state().call).toBe("live");
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)))));
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
          yield* core.setOrchestrator("orchestrator", "thinking");
          yield* core.setOrchestrator("orchestrator", "thinking");
          yield* core.apply({ type: "progress", progress: emptyProgress() });
          yield* core.setCommits({ total: 1, today: 0, week: 0 } as never);
          const got = yield* Fiber.join(seen);
          expect(got.map((e) => e.type)).toEqual(["snapshot", "hired", "orchestrator", "progress"]);
          expect(got[2]!.at).toBeGreaterThan(0);
        }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config))))),
      );
      const kept = JSON.parse(readFileSync(join(config.home, "state.json"), "utf8")) as Record<string, unknown>;
      expect(kept.orchestrators).toEqual({ orchestrator: { state: "thinking", since: expect.any(Number) } });
      expect(kept.progress).toBeUndefined();
      expect(JSON.stringify(kept)).not.toMatch(/phaseText|whenText/u);
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
      expect((yield* Queue.take(frames)).state.orchestrators).toEqual({});
      yield* core.setOrchestrator("orchestrator", "speaking");
      yield* core.setCommits({ total: 2 } as never);
      yield* TestClock.adjust(stateEveryMs);
      const next = yield* Queue.take(frames);
      expect([next.state.orchestrators.orchestrator?.state, next.state.commits?.total]).toEqual(["speaking", 2]);
      yield* TestClock.adjust(stateEveryMs * 2);
      expect(yield* Queue.size(frames)).toBe(0);
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig()))))),
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
      for (let i = 0; i < 128; i++) yield* core.setOrchestrator("orchestrator", i % 2 === 0 ? "thinking" : "speaking");
      yield* TestClock.adjust(200);
      expect(yield* Fiber.join(seen)).toBe(128);
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig()))))),
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
          yield* core.setOrchestrator("orchestrator", "thinking");
          yield* TestClock.adjust(600);
          expect(messages.some((message) => String(message).includes("state.json could not be saved"))).toBe(true);
          rmSync(join(config.home, "state.json"), { recursive: true });
        }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config))))),
      );
      expect(readFileSync(join(config.home, "state.json"), "utf8")).toContain("thinking");
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });

  it.effect("each orchestrator's state says where it thinks and writes, forgets it once it listens, and leaves at rest", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* core.setOrchestrator("orchestrator", "thinking", "c1");
      yield* core.setOrchestrator("lead", "speaking", "c2");
      expect(core.state().orchestrators).toEqual({
        orchestrator: { state: "thinking", channel: "c1", since: expect.any(Number) },
        lead: { state: "speaking", channel: "c2", since: expect.any(Number) },
      });
      // A round begins when it starts thinking and goes on while it writes.
      const began = core.state().orchestrators.orchestrator!.since;
      yield* TestClock.adjust(5_000);
      yield* core.setOrchestrator("orchestrator", "speaking", "c1");
      expect(core.state().orchestrators.orchestrator?.since).toBe(began);
      yield* core.setOrchestrator("orchestrator", "listening");
      expect(core.state().orchestrators.orchestrator).toEqual({ state: "listening" });
      yield* core.setOrchestrator("orchestrator", "idle");
      yield* core.setOrchestrator("lead", "idle");
      expect(core.state().orchestrators).toEqual({});
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig()))))),
  );

  it.effect("apply stays synchronous for oar callbacks", () =>
    Effect.gen(function* () {
      const runSync = Effect.runSyncWith(yield* Effect.context());
      const core = yield* Core;
      yield* Effect.sync(() => runSync(core.apply({ type: "orchestrator", agent: "orchestrator", state: "thinking" })));
      expect(core.state().orchestrators.orchestrator?.state).toBe("thinking");
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig()))))),
  );
});
