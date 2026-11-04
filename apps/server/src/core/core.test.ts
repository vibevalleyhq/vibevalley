import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, PubSub, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import type { WorkspaceState, Session, StateFrame } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { emptyProgress } from "#/game/progress.ts";
import { ServerConfig } from "#/infra/config.ts";
import { layer as projection } from "#/projection/frame.ts";
import { testConfig, whenState } from "#/testing/layers.ts";

import { bounded, Core, emptyWorkspaceState, stateEveryMs } from "./core.ts";

const helper: Session = {
  id: sessionId("w1"),
  role: "worker",
  name: "帮工",
  agent: "lab",
  runtime: "pi",
  brief: "写",
  hiredAt: 0,
  runs: 0,
  phase: { _tag: "done" },
  refining: false,
};

const phaseOf = (action: "thinking" | "speaking", since = 0): Session["phase"] => ({
  _tag: "working",
  since,
  doing: { action: action === "speaking" ? "speaking_text" : "thinking", label: "" },
});
const activity = Effect.fnUntraced(function* (core: Core["Service"], agent: string, action: "thinking" | "speaking", channel?: string) {
  const id = sessionId(agent);
  const had = core.session(id);
  const since = had?.phase._tag === "working" ? had.phase.since : yield* Clock.currentTimeMillis;
  yield* core.apply(...(had ? [] : [{ type: "sessionChanged" as const, session: { ...helper, id, agent, role: "orchestrator" as const } }]), {
    type: "sessionPhaseChanged",
    id,
    phase: phaseOf(action, since),
    ...(channel ? { channel } : {}),
  });
});

describe("core", () => {
  it("regression: a successful state wait releases its real-time deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const found = await Effect.runPromise(
        Effect.gen(function* () {
          const core = yield* Core;
          const waiting = yield* Effect.forkChild(whenState((s) => s.call === "live", "live call", 60_000));
          yield* Effect.yieldNow;
          yield* core.open();
          return yield* Fiber.join(waiting);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer)),
          ),
        ),
      );
      expect(found).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.effect("regression: the core ignores legacy state.json and starts from its empty projection", () => {
    const config = testConfig();
    const was: WorkspaceState = {
      ...emptyWorkspaceState(),
      call: "live",
      callReason: "挂了",
      sessions: [helper],
      progress: emptyProgress(),
      crons: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    return Effect.gen(function* () {
      const s = (yield* Core).state();
      expect([s.call, s.callReason]).toEqual(["idle", ""]);
      expect([s.progress, s.crons, s.issues]).toEqual([undefined, [], []]);
      expect(s.sessions).toEqual([]);
      expect(readFileSync(join(config.home, "state.json"), "utf8")).toBe(JSON.stringify(was));
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)), Layer.provide(NodeServices.layer))));
  });

  it.effect("regression: a legacy state file is neither decoded nor rewritten", () => {
    const config = testConfig();
    const raw = JSON.stringify({ call: "idle", sessions: {} });
    writeFileSync(join(config.home, "state.json"), raw);
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect((yield* Core).state()).toEqual(emptyWorkspaceState());
        }).pipe(
          Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)), Layer.provide(NodeServices.layer))),
        ),
      );
      const kept = readdirSync(config.home).filter((f) => f.startsWith("state.json.unreadable-"));
      expect(kept).toHaveLength(0);
      expect(readFileSync(join(config.home, "state.json"), "utf8")).toBe(raw);
    });
  });

  it.effect("open reads the call state when its effect runs", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const core = yield* Core;
      yield* core.open();
      const reopen = core.open();
      yield* core.apply({ type: "callChanged", state: "idle", reason: "" });
      expect(core.state().call).toBe("idle");
      yield* reopen;
      expect(core.state().call).toBe("live");
    }).pipe(Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)), Layer.provide(NodeServices.layer))));
  });

  it.effect("a fact is stamped and sent without creating a file snapshot", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const core = yield* Core;
          const seen = yield* core.events.pipe(Stream.take(6), Stream.runCollect, Effect.forkScoped);
          yield* TestClock.adjust(5);
          yield* core.apply({ type: "sessionChanged", session: { ...helper, phase: { _tag: "working", since: 5, doing: { action: "none", label: "" } } } });
          yield* activity(core, "orchestrator", "thinking");
          yield* activity(core, "orchestrator", "thinking");
          yield* core.apply({ type: "progressChanged", progress: emptyProgress() });
          yield* core.setCommits({ total: 1, today: 0, week: 0 } as never);
          const got = yield* Fiber.join(seen);
          expect(got.map((e) => e.type)).toEqual(["snapshot", "sessionChanged", "sessionChanged", "sessionPhaseChanged", "progressChanged", "progressChanged"]);
          expect(got[2]!.at).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, config)), Layer.provide(NodeServices.layer))),
        ),
      );
      expect(existsSync(join(config.home, "state.json"))).toBe(false);
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
      expect((yield* Queue.take(frames)).state.sessions).toEqual([]);
      yield* activity(core, "orchestrator", "speaking");
      yield* core.setCommits({ total: 2 } as never);
      yield* TestClock.adjust(stateEveryMs);
      const next = yield* Queue.take(frames);
      expect([next.state.sessions.find((s) => s.id === "orchestrator")?.phase, next.state.commits?.total]).toMatchObject([
        phaseOf("speaking", expect.any(Number)),
        2,
      ]);
      yield* TestClock.adjust(stateEveryMs * 2);
      expect(yield* Queue.size(frames)).toBe(0);
    }).pipe(
      Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    ),
  );

  it.effect("seq goes up once per commit that changes the state, and a frame carries the seq of the state it shows", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const frames = yield* Queue.unbounded<StateFrame>();
      yield* core.states.pipe(
        Stream.runForEach((f) => Queue.offer(frames, f)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(frames)).seq).toBe(0);
      yield* activity(core, "orchestrator", "thinking");
      expect(core.seq()).toBe(1);
      // The same again changes nothing: no fold, no seq.
      yield* activity(core, "orchestrator", "thinking");
      expect(core.seq()).toBe(1);
      // A batch is one commit.
      yield* core.apply(
        { type: "sessionPhaseChanged", id: sessionId("orchestrator"), phase: phaseOf("speaking") },
        { type: "progressChanged", commits: { total: 3, repos: [] } },
      );
      const replied = core.seq();
      expect(replied).toBe(2);
      yield* TestClock.adjust(stateEveryMs);
      const next = yield* Queue.take(frames);
      // What a reply read after its change says (replied) is no later than the first frame that shows the change.
      expect(next.seq).toBeGreaterThanOrEqual(replied);
      expect(next.state.commits?.total).toBe(3);
    }).pipe(
      Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    ),
  );

  it.effect("an internal subscriber keeps a whole burst while it works", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* activity(core, "orchestrator", "speaking");
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
      for (let i = 0; i < 128; i++) yield* activity(core, "orchestrator", i % 2 === 0 ? "thinking" : "speaking");
      yield* TestClock.adjust(200);
      expect(yield* Fiber.join(seen)).toBe(128);
    }).pipe(
      Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    ),
  );

  it.effect("session phases update independently and keep their supplied run start", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* activity(core, "orchestrator", "thinking", "c1");
      yield* activity(core, "lead", "speaking", "c2");
      const began = core.session("orchestrator")!.phase;
      yield* TestClock.adjust(5_000);
      yield* activity(core, "orchestrator", "speaking", "c1");
      expect(core.session("orchestrator")?.phase).toMatchObject({ _tag: "working", since: began._tag === "working" ? began.since : 0 });
      expect(core.session("lead")?.channel).toBe("c2");
      yield* core.apply({ type: "sessionPhaseChanged", id: sessionId("orchestrator"), phase: { _tag: "resting" } });
      expect(core.session("orchestrator")).toMatchObject({ phase: { _tag: "resting" } });
      expect(core.session("orchestrator")?.channel).toBeUndefined();
      expect(core.session("lead")?.phase).toEqual(phaseOf("speaking", expect.any(Number)));
    }).pipe(
      Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    ),
  );

  it.effect("apply stays synchronous for oar callbacks", () =>
    Effect.gen(function* () {
      const runSync = Effect.runSyncWith(yield* Effect.context());
      const core = yield* Core;
      yield* core.apply({ type: "sessionChanged", session: helper });
      yield* Effect.sync(() => runSync(core.apply({ type: "sessionPhaseChanged", id: helper.id, phase: phaseOf("thinking") })));
      expect(core.session(helper.id)?.phase).toEqual(phaseOf("thinking"));
    }).pipe(
      Effect.provide(Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer))),
    ),
  );
});

describe("bounded streams", () => {
  it.effect("keeps the source order", () =>
    Effect.gen(function* () {
      expect(yield* bounded(Stream.make(1, 2, 3), "test").pipe(Stream.runCollect)).toEqual([1, 2, 3]);
    }),
  );

  it.effect("ends the slow subscription and runs the source finalizer once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<number>();
        let finalized = 0;
        const source = Stream.fromPubSub(pubsub).pipe(Stream.ensuring(Effect.sync(() => finalized++)));
        const fiber = yield* Effect.forkChild(Stream.runDrain(bounded(source, "test", 2)));
        yield* TestClock.adjust(5);
        yield* PubSub.publish(pubsub, 1);
        yield* PubSub.publish(pubsub, 2);
        yield* PubSub.publish(pubsub, 3);
        yield* Fiber.await(fiber);
        expect(finalized).toBe(1);
      }),
    ),
  );
});
