import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { Hub } from "@vibevalley/async";
import type { SpaceState, Session, StateFrame } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { makeProjection } from "#/gateway/projection/frame.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { emptyProgress } from "#/modules/game/progress.ts";
import { testConfig, whenState } from "#/testing/layers.ts";

import { bounded, type Core, emptySpaceState, makeCore, stateEveryMs } from "./core.ts";

// The core reads no files: a config is given only to say where a legacy state.json would have been.
const coreOf = (_config: ServerConfig = testConfig()) => makeCore({ projection: makeProjection(), clock: wallTime });

afterEach(() => {
  vi.useRealTimers();
});

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
const activity = (core: Core, agent: string, action: "thinking" | "speaking", channel?: string) => {
  const id = sessionId(agent);
  const had = core.session(id);
  const since = had?.phase._tag === "working" ? had.phase.since : wallTime.now();
  core.apply(...(had ? [] : [{ type: "sessionChanged" as const, session: { ...helper, id, agent, role: "orchestrator" as const } }]), {
    type: "sessionPhaseChanged",
    id,
    phase: phaseOf(action, since),
    ...(channel ? { channel } : {}),
  });
};

/** Every value of it from now on, kept as they come, until stop. */
function collect<A>(source: (signal: AbortSignal) => AsyncIterable<A>) {
  const got: A[] = [];
  const stopped = new AbortController();
  const reading = (async () => {
    for await (const a of source(stopped.signal)) got.push(a);
  })();
  return {
    got,
    stop: async () => {
      stopped.abort();
      // Its end is the abort just asked for.
      await reading.catch(() => undefined);
    },
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("core", () => {
  test("regression: a successful state wait releases its real-time deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const core = coreOf();
      const waiting = whenState(core, (s) => s.call === "live", "live call", 60_000);
      await Promise.resolve();
      core.open();
      const found = await waiting;
      expect(found).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("regression: the core ignores legacy state.json and starts from its empty projection", () => {
    const config = testConfig();
    const was: SpaceState = {
      ...emptySpaceState(),
      call: "live",
      callReason: "挂了",
      sessions: [helper],
      progress: emptyProgress(),
      crons: [],
      issues: [],
    };
    writeFileSync(join(config.home, "state.json"), JSON.stringify(was));
    const s = coreOf(config).state();
    expect([s.call, s.callReason]).toEqual(["idle", ""]);
    expect([s.progress, s.crons, s.issues]).toEqual([undefined, [], []]);
    expect(s.sessions).toEqual([]);
    expect(readFileSync(join(config.home, "state.json"), "utf8")).toBe(JSON.stringify(was));
  });

  test("regression: a legacy state file is neither decoded nor rewritten", () => {
    const config = testConfig();
    const raw = JSON.stringify({ call: "idle", sessions: {} });
    writeFileSync(join(config.home, "state.json"), raw);
    const core = coreOf(config);
    expect(core.state()).toEqual(emptySpaceState());
    core.close();
    const kept = readdirSync(config.home).filter((f) => f.startsWith("state.json.unreadable-"));
    expect(kept).toHaveLength(0);
    expect(readFileSync(join(config.home, "state.json"), "utf8")).toBe(raw);
  });

  test("open reads the call state when its effect runs", () => {
    const core = coreOf();
    core.open();
    core.apply({ type: "callChanged", state: "idle", reason: "" });
    expect(core.state().call).toBe("idle");
    core.open();
    expect(core.state().call).toBe("live");
  });

  test("a fact is stamped and sent without creating a file snapshot", async () => {
    vi.useFakeTimers({ now: 0 });
    const config = testConfig();
    const core = coreOf(config);
    const seen = collect((signal) => core.events(signal));
    await vi.advanceTimersByTimeAsync(5);
    core.apply({ type: "sessionChanged", session: { ...helper, phase: { _tag: "working", since: 5, doing: { action: "none", label: "" } } } });
    activity(core, "orchestrator", "thinking");
    activity(core, "orchestrator", "thinking");
    core.apply({ type: "progressChanged", progress: emptyProgress() });
    core.setCommits({ total: 1, repos: [] });
    vi.useRealTimers();
    await vi.waitFor(() => expect(seen.got.length).toBeGreaterThanOrEqual(6));
    await seen.stop();
    const got = seen.got.slice(0, 6);
    expect(got.map((e) => e.type)).toEqual(["snapshot", "sessionChanged", "sessionChanged", "sessionPhaseChanged", "progressChanged", "progressChanged"]);
    expect(got[2]!.at).toBeGreaterThan(0);
    core.close();
    expect(existsSync(join(config.home, "state.json"))).toBe(false);
  });

  test("a burst of facts is one frame", async () => {
    vi.useFakeTimers();
    const core = coreOf();
    const frames = collect<StateFrame>((signal) => core.states(signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.got.shift()?.state.sessions).toEqual([]);
    activity(core, "orchestrator", "speaking");
    core.setCommits({ total: 2, repos: [] });
    await vi.advanceTimersByTimeAsync(stateEveryMs);
    const next = frames.got.shift()!;
    expect([next.state.sessions.find((s) => s.id === "orchestrator")?.phase, next.state.commits?.total]).toMatchObject([
      phaseOf("speaking", expect.any(Number)),
      2,
    ]);
    await vi.advanceTimersByTimeAsync(stateEveryMs * 2);
    const size2 = frames.got.length;
    expect(size2).toBe(0);
    core.close();
    await frames.stop();
  });

  test("seq goes up once per commit that changes the state, and a frame carries the seq of the state it shows", async () => {
    vi.useFakeTimers();
    const core = coreOf();
    const frames = collect<StateFrame>((signal) => core.states(signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.got.shift()?.seq).toBe(0);
    activity(core, "orchestrator", "thinking");
    expect(core.seq()).toBe(1);
    // The same again changes nothing: no fold, no seq.
    activity(core, "orchestrator", "thinking");
    expect(core.seq()).toBe(1);
    // A batch is one commit.
    core.apply(
      { type: "sessionPhaseChanged", id: sessionId("orchestrator"), phase: phaseOf("speaking") },
      { type: "progressChanged", commits: { total: 3, repos: [] } },
    );
    const replied = core.seq();
    expect(replied).toBe(2);
    await vi.advanceTimersByTimeAsync(stateEveryMs);
    const next = frames.got.shift()!;
    // What a reply read after its change says (replied) is no later than the first frame that shows the change.
    expect(next.seq).toBeGreaterThanOrEqual(replied);
    expect(next.state.commits?.total).toBe(3);
    core.close();
    await frames.stop();
  });

  test("an internal subscriber keeps a whole burst while it works", async () => {
    vi.useFakeTimers();
    const core = coreOf();
    activity(core, "orchestrator", "speaking");
    const incoming = core.subscribe();
    let seen = 0;
    const reading = (async () => {
      for (let r = await incoming.next(); r.done !== true && seen < 128; r = await incoming.next()) {
        seen++;
        if (seen === 128) break;
        // On the fake timers: a reader slower than the burst, not a wait.
        await wallTime.sleep(1);
      }
    })();
    await vi.advanceTimersByTimeAsync(5);
    for (let i = 0; i < 128; i++) activity(core, "orchestrator", i % 2 === 0 ? "thinking" : "speaking");
    await vi.advanceTimersByTimeAsync(200);
    await reading;
    const seen2 = seen;
    expect(seen2).toBe(128);
    incoming.close();
    core.close();
  });

  test("session phases update independently and keep their supplied run start", async () => {
    vi.useFakeTimers();
    const core = coreOf();
    activity(core, "orchestrator", "thinking", "c1");
    activity(core, "lead", "speaking", "c2");
    const began = core.session("orchestrator")!.phase;
    await vi.advanceTimersByTimeAsync(5_000);
    activity(core, "orchestrator", "speaking", "c1");
    expect(core.session("orchestrator")?.phase).toMatchObject({ _tag: "working", since: began._tag === "working" ? began.since : 0 });
    expect(core.session("lead")?.channel).toBe("c2");
    core.apply({ type: "sessionPhaseChanged", id: sessionId("orchestrator"), phase: { _tag: "resting" } });
    expect(core.session("orchestrator")).toMatchObject({ phase: { _tag: "resting" } });
    expect(core.session("orchestrator")?.channel).toBeUndefined();
    expect(core.session("lead")?.phase).toEqual(phaseOf("speaking", expect.any(Number)));
  });

  test("regression: a scheduler yield cannot leave the core locked against a synchronous callback", async () => {
    const core = coreOf();
    const rounds = Array.from({ length: 32 }, (_, i) => i);
    const writer = (async () => {
      for (const i of rounds) {
        core.apply({ type: "callChanged", state: "live", reason: `writer-${i}` });
        await Promise.resolve();
      }
    })();
    const callbacks = (async () => {
      for (const i of rounds) {
        core.apply({ type: "callChanged", state: "idle", reason: `callback-${i}` });
        await turn();
      }
    })();
    await Promise.all([writer, callbacks]);
    expect(core.seq()).toBe(rounds.length * 2);
  });

  test("apply stays synchronous for oar callbacks", () => {
    const core = coreOf();
    core.apply({ type: "sessionChanged", session: helper });
    core.apply({ type: "sessionPhaseChanged", id: helper.id, phase: phaseOf("thinking") });
    expect(core.session(helper.id)?.phase).toEqual(phaseOf("thinking"));
  });
});

describe("bounded streams", () => {
  test("keeps the source order", async () => {
    async function* source() {
      yield* [1, 2, 3];
    }
    const bounded2: number[] = [];
    for await (const n of bounded(source(), "test", keptLog())) bounded2.push(n);
    expect(bounded2).toEqual([1, 2, 3]);
  });

  test("ends the slow subscription and runs the source finalizer once", async () => {
    const hub = new Hub<number>();
    let finalized = 0;
    const sub = hub.subscribe();
    async function* source() {
      try {
        yield* sub;
      } finally {
        finalized++;
      }
    }
    const slow = bounded(source(), "test", keptLog(), 2);
    // The reader takes one and then nothing while the source runs on: the fourth value finds the queue of two full.
    const first = slow.next();
    await turn();
    hub.publish(1);
    hub.publish(2);
    hub.publish(3);
    hub.publish(4);
    await turn();
    await first;
    for (let r = await slow.next(); r.done !== true; r = await slow.next());
    expect(finalized).toBe(1);
  });
});
