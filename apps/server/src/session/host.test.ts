import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testConfig } from "../testing/layers.ts";
import { aTurn, until } from "../testing/until.ts";
import { world } from "../testing/world.ts";
import { scriptedLLM } from "../agent/brain/testing.ts";
import { answer, text, toolCall } from "../ai/testing.ts";
import { Sessions } from "./session.ts";
import { Caller } from "./host.ts";
import type { OrchestratorState } from "@vibevalley/protocol";

describe("Caller", () => {
  it("removes the abort listener after every kind of wake", async () => {
    const caller = new Caller();
    const ended = new AbortController();
    const signal = ended.signal;
    let active = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => {
      if (args[0] === "abort") active++;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof signal.removeEventListener>) => {
      if (args[0] === "abort") active--;
      remove(...args);
    };
    const words = caller.words(signal);
    for (let i = 0; i < 20; i++) {
      const next = words.next();
      caller.push(`word ${i}`);
      expect((await next).value).toBe(`word ${i}`);
      expect(active).toBe(0);
    }
    const last = words.next();
    ended.abort();
    expect((await last).done).toBe(true);
    expect(active).toBe(0);
  });

  it("does not wait or add a listener for an already aborted signal", async () => {
    const caller = new Caller();
    const ended = new AbortController();
    ended.abort();
    const words = caller.words(ended.signal);
    caller.push("not read");
    expect((await words.next()).done).toBe(true);
  });
});

describe("AgentHost", () => {
  it.live("says each answer once, whole, while the caller gets its words as they grow", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { llm } = scriptedLLM([answer([text("我看一下"), toolCall("missing", {})]), answer("看完了，一切正常")]);
      const said: string[] = [];
      const states: OrchestratorState[] = [];
      const host = sessions.host({
        name: "orchestrator",
        label: "管家",
        inputType: "testInput",
        home: config.home,
        cwd: config.workRoot,
        instructions: "",
        llm: () => llm,
        tools: () => [],
        first: "first",
        quiet: () => false,
        say: async (_route, words) => void said.push(words),
        state: async (s) => void states.push(s),
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
        notice: () => {},
        log: () => {},
        go: <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e),
        scope: yield* Effect.scope,
      });
      const caller = new Caller();
      const heard: string[] = [];
      const reading = (async () => {
        for await (const w of caller.words()) heard.push(w);
      })();
      const result = yield* Effect.promise(() => host.submit(async () => ({ text: "看看" }), { route: "r", run: { by: { kind: "" } }, caller }, true));
      expect(result.ok).toBe(true);
      yield* until(() => states.at(-1) === "listening" && said.length === 2, "the run settled");
      yield* Effect.promise(() => reading);
      expect(said).toEqual(["我看一下", "看完了，一切正常"]);
      // A character at a time from the script: more pushes than answers.
      expect(heard.length).toBeGreaterThan(2);
      expect(heard.join("")).toBe("我看一下\n看完了，一切正常\n");
      expect(states.filter((s, i) => s !== states[i - 1])).toEqual(["thinking", "speaking", "thinking", "speaking", "thinking", "listening"]);
      yield* Effect.promise(() => host.close());
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });

  it.live("waits for an input build before closing, without delivering it late", () => {
    const config = testConfig();
    let started = () => {};
    const building = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { llm } = scriptedLLM();
      const host = sessions.host({
        name: "orchestrator",
        label: "管家",
        inputType: "testInput",
        home: config.home,
        cwd: config.workRoot,
        instructions: "",
        llm: () => llm,
        tools: () => [],
        first: "first",
        quiet: () => true,
        say: async () => {},
        state: async () => {},
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
        notice: () => {},
        log: () => {},
        go: <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e),
        scope: yield* Effect.scope,
      });
      const caller = new Caller();
      const submitting = host.submit(
        async () => {
          started();
          await gate;
          return { text: "late" };
        },
        { route: "late", run: { by: { kind: "" } }, caller },
        true,
      );
      yield* Effect.promise(() => building);
      const closing = host.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      // A close that did not wait for the build would have ended by the next turn.
      yield* aTurn;
      expect(closed).toBe(false);
      release();
      const result = yield* Effect.promise(() => submitting);
      expect(result.ok).toBe(false);
      expect(host.close()).toBe(closing);
      yield* Effect.promise(() => closing);
      expect(host.current().route).toBe("first");
      expect((yield* Effect.promise(() => caller.words().next())).done).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });
});
