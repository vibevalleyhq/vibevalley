import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Brain, type BrainEvent } from "../agent/brain/agent.ts";
import type { LLM } from "../agent/brain/config.ts";
import { messageText } from "../agent/brain/messages.ts";
import { AgentHost, Caller, type Hosted, type HostOptions } from "./host.ts";
import type { Journal } from "./journal.ts";
import type { RunStore } from "./session.ts";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not met");
};

const fakeBrain = (calls: string[]) => {
  const listeners = new Set<(e: BrainEvent) => void>();
  const sent: AgentMessage[] = [];
  const queued: AgentMessage[] = [];
  const brain = {
    core: { state: { messages: [] as AgentMessage[] }, hasQueuedMessages: () => queued.length > 0 },
    busy: () => false,
    memoryNews: () => "",
    subscribe: (listener: (e: BrainEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    send: (message: AgentMessage) => {
      sent.push(message);
      calls.push("send:" + messageText(message));
    },
    later: (message: AgentMessage) => {
      queued.push(message);
      calls.push("later:" + messageText(message));
    },
    stop: () => {
      calls.push("brain.stop");
      return Promise.resolve();
    },
    close: () => {
      calls.push("brain.close");
      return Promise.resolve();
    },
    resume: () => false,
  } as unknown as Brain;
  return {
    brain,
    sent,
    queued,
    emit: (e: BrainEvent) => {
      for (const listener of listeners) listener(e);
    },
  };
};

const input = (route: string, caller?: Caller): Hosted<string> => ({
  route,
  run: { by: { kind: "comment" }, asked: route },
  ...(caller ? { caller } : {}),
});

const fixture = (calls: string[] = [], state?: HostOptions<string>["state"], onRunStart?: () => void) => {
  const notices: string[] = [];
  const logs: string[] = [];
  const journal: Journal = {
    events: () => [],
    asked: () => {},
    said: () => {},
    thought: () => {},
    toolStarted: () => {},
    toolInput: () => {},
    toolEnded: () => {},
    note: () => {},
    usage: () => {},
    runStarted: () => {},
    runEnded: () => {},
    close: () => {},
  };
  const runs: RunStore = {
    start: () => Effect.sync(() => onRunStart?.()),
    link: () => Effect.void,
    heard: () => Effect.void,
    issues: () =>
      Effect.sync(() => {
        calls.push("execution.close");
        return [];
      }),
    finish: () => Effect.void,
    finished: () => {},
    consumed: () => {},
    register: () => {},
  };
  const host = new AgentHost<string>(
    {
      name: "host-test",
      label: "管家",
      inputType: "host-test-input",
      home: "/unused",
      cwd: "/unused",
      instructions: "",
      llm: () => ({ model: { id: "test" } }) as unknown as LLM,
      tools: () => [],
      first: "first",
      quiet: () => true,
      say: () => Promise.resolve(),
      state: state ?? (() => Promise.resolve()),
      fresh: () => {},
      restored: () => ({ by: { kind: "" } }),
      toolStart: (tool) => ({ text: tool, action: "other", tool }),
      notice: (level, text) => notices.push(level + ":" + text),
      log: (level, text) => logs.push(level + ":" + text),
      go: <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e),
    },
    journal,
    runs,
  );
  return { host, notices, logs, runs };
};

const messageStart = (message: AgentMessage) => ({ type: "message_start", message }) as BrainEvent;
const texts = (messages: readonly AgentMessage[]) => messages.map((message) => messageText(message));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentHost input lifetime", () => {
  it("stop ends a deferred build without delivering it and admits the next generation", async () => {
    const calls: string[] = [];
    const fake = fakeBrain(calls);
    vi.spyOn(Brain, "start").mockResolvedValue(fake.brain);
    const { host } = fixture(calls);
    const building = deferred<void>();
    const entered = deferred<void>();
    const oldCaller = new Caller();
    const oldEnd = vi.spyOn(oldCaller, "end");
    const oldBuild = vi.fn(async () => {
      entered.resolve();
      await building.promise;
      calls.push("old build settled");
      return { text: "old" };
    });
    const oldSubmission = host.submit(oldBuild, input("old", oldCaller), true);
    await entered.promise;

    const stopping = host.stop();
    expect(oldEnd).toHaveBeenCalledTimes(1);
    expect(await oldCaller.words().next()).toEqual({ done: true, value: undefined });
    const newSubmission = host.submit(async () => ({ text: "new" }), input("new", new Caller()), true);
    building.resolve();

    expect(await oldSubmission).toEqual({ ok: true });
    expect(await newSubmission).toEqual({ ok: true });
    await stopping;
    expect(oldBuild).toHaveBeenCalledTimes(1);
    expect(texts(fake.sent)).toEqual(["new"]);
    expect(calls).not.toContain("send:old");
    await host.close();
    expect(oldEnd).toHaveBeenCalledTimes(1);
  });

  it("close waits for the build, brain and events before closing execution", async () => {
    const calls: string[] = [];
    const fake = fakeBrain(calls);
    vi.spyOn(Brain, "start").mockResolvedValue(fake.brain);
    const eventEntered = deferred<void>();
    const eventGate = deferred<void>();
    const { host } = fixture(calls, async (state) => {
      if (state !== "thinking") return;
      eventEntered.resolve();
      await eventGate.promise;
      calls.push("events");
    });
    await host.submit(async () => ({ text: "seed" }), input("seed"), true);
    fake.emit(messageStart(fake.sent[0]!));
    fake.emit({ type: "agent_start" } as BrainEvent);
    await eventEntered.promise;

    const building = deferred<void>();
    const buildEntered = deferred<void>();
    const caller = new Caller();
    const end = vi.spyOn(caller, "end");
    const submission = host.submit(
      async () => {
        buildEntered.resolve();
        await building.promise;
        calls.push("build settled");
        return { text: "late" };
      },
      input("late", caller),
      true,
    );
    await buildEntered.promise;
    const closing = host.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("brain.close");

    building.resolve();
    expect(await submission).toEqual({ ok: true });
    await until(() => calls.includes("brain.close"));
    expect(closed).toBe(false);
    expect(texts(fake.sent)).toEqual(["seed"]);
    eventGate.resolve();
    await closing;

    expect(calls.slice(-4)).toEqual(["build settled", "brain.close", "events", "execution.close"]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends current and queued callers once across message_start, stop, settled and close", async () => {
    const calls: string[] = [];
    const fake = fakeBrain(calls);
    vi.spyOn(Brain, "start").mockResolvedValue(fake.brain);
    const { host } = fixture(calls);
    const callers = [new Caller(), new Caller(), new Caller()];
    const ends = callers.map((caller) => vi.spyOn(caller, "end"));
    await host.submit(async () => ({ text: "one" }), input("one", callers[0]), true);
    await host.submit(async () => ({ text: "two" }), input("two", callers[1]), false);
    await host.submit(async () => ({ text: "three" }), input("three", callers[2]), false);

    fake.emit(messageStart(fake.sent[0]!));
    await until(() => host.current().route === "one");
    expect(ends.map((end) => end.mock.calls.length)).toEqual([0, 0, 0]);
    fake.emit(messageStart(fake.queued[0]!));
    await until(() => host.current().route === "two");
    expect(ends.map((end) => end.mock.calls.length)).toEqual([1, 0, 0]);

    await host.stop();
    expect(ends.map((end) => end.mock.calls.length)).toEqual([1, 1, 1]);
    for (const caller of callers) expect(await caller.words().next()).toEqual({ done: true, value: undefined });
    fake.emit({ type: "agent_settled", run: { aborted: true } } as BrainEvent);
    await host.close();
    expect(ends.map((end) => end.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("stop waits for a deferred start and only delivers the new generation", async () => {
    const calls: string[] = [];
    const fake = fakeBrain(calls);
    const starting = deferred<Brain>();
    const start = vi.spyOn(Brain, "start").mockReturnValue(starting.promise);
    const { host, notices } = fixture(calls);
    const oldCaller = new Caller();
    const oldEnd = vi.spyOn(oldCaller, "end");
    const oldBuild = vi.fn(async () => ({ text: "old" }));
    const oldSubmission = host.submit(oldBuild, input("old", oldCaller), true);
    await until(() => start.mock.calls.length === 1);

    const stopping = host.stop();
    const newSubmission = host.submit(async () => ({ text: "new" }), input("new", new Caller()), true);
    starting.resolve(fake.brain);
    expect(await oldSubmission).toEqual({ ok: true });
    expect(await newSubmission).toEqual({ ok: true });
    await stopping;

    expect(oldEnd).toHaveBeenCalledTimes(1);
    expect(oldBuild).not.toHaveBeenCalled();
    expect(texts(fake.sent)).toEqual(["new"]);
    expect(calls).toEqual(["brain.stop", "send:new"]);
    expect(notices).toEqual([]);
    await host.close();
    expect(oldEnd).toHaveBeenCalledTimes(1);
  });

  it("close waits for a deferred start and rejects later submit and resume without another start", async () => {
    const calls: string[] = [];
    const fake = fakeBrain(calls);
    const starting = deferred<Brain>();
    const start = vi.spyOn(Brain, "start").mockReturnValue(starting.promise);
    const { host, notices } = fixture(calls);
    const oldCaller = new Caller();
    const oldEnd = vi.spyOn(oldCaller, "end");
    const oldBuild = vi.fn(async () => ({ text: "old" }));
    const oldSubmission = host.submit(oldBuild, input("old", oldCaller), true);
    await until(() => start.mock.calls.length === 1);

    const closing = host.close();
    expect(oldEnd).toHaveBeenCalledTimes(1);
    const afterCaller = new Caller();
    const afterEnd = vi.spyOn(afterCaller, "end");
    const afterBuild = vi.fn(async () => ({ text: "after" }));
    const rejected = await host.submit(afterBuild, input("after", afterCaller), true);
    await host.resume(1000);
    expect(rejected).toMatchObject({ ok: false, run: "" });
    expect(afterEnd).toHaveBeenCalledTimes(1);
    expect(afterBuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("brain.close");

    starting.resolve(fake.brain);
    expect(await oldSubmission).toEqual({ ok: true });
    await closing;
    expect(oldBuild).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([]);
    expect(fake.queued).toEqual([]);
    expect(calls).toEqual(["brain.close"]);
    expect(notices).toEqual([]);
    await host.close();
    expect(calls).toEqual(["brain.close"]);
    expect(oldEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps start and build failures on their original paths and ends their callers", async () => {
    const startFailure = new Error("missing key");
    vi.spyOn(Brain, "start").mockRejectedValueOnce(startFailure);
    const { host, notices } = fixture();
    const failedCaller = new Caller();
    const failedEnd = vi.spyOn(failedCaller, "end");
    const failed = await host.submit(async () => ({ text: "never" }), input("failed", failedCaller), true);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.why).toBe("missing key");
      expect(failed.run).not.toBe("");
    }
    expect(failedEnd).toHaveBeenCalledTimes(1);
    const words = failedCaller.words();
    expect(await words.next()).toEqual({ done: false, value: "我这边起不来：missing key" });
    expect(await words.next()).toEqual({ done: true, value: undefined });
    expect(notices).toContain("error:管家起不来：missing key");

    const calls: string[] = [];
    const fake = fakeBrain(calls);
    vi.spyOn(Brain, "start").mockResolvedValue(fake.brain);
    const { host: buildingHost } = fixture(calls);
    const caller = new Caller();
    const end = vi.spyOn(caller, "end");
    const buildFailure = new Error("build failed");
    await expect(
      buildingHost.submit(
        async () => {
          throw buildFailure;
        },
        input("build", caller),
        true,
      ),
    ).rejects.toBe(buildFailure);
    expect(end).toHaveBeenCalledTimes(1);
    expect(fake.sent).toEqual([]);
    await buildingHost.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("close waits for a start failure already being recorded", async () => {
    const calls: string[] = [];
    let rejectStart!: (reason: Error) => void;
    const starting = new Promise<Brain>((_, reject) => {
      rejectStart = reject;
    });
    vi.spyOn(Brain, "start").mockReturnValue(starting);
    const { host, runs } = fixture(calls);
    const recording = deferred<void>();
    const finishRecording = deferred<void>();
    vi.spyOn(runs, "start").mockImplementation(() => {
      recording.resolve();
      return Effect.promise(() => finishRecording.promise);
    });
    const finished = vi.spyOn(runs, "finished");
    const submitted = host.submit(async () => ({ text: "never" }), input("failed"), true);
    rejectStart(new Error("missing key"));
    await recording.promise;

    const closing = host.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finishRecording.resolve();

    expect(await submitted).toMatchObject({ ok: false, run: expect.not.stringMatching(/^$/) });
    await closing;
    expect(closed).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["execution.close"]);
  });
});
