import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer, text, toolCall } from "@vibevalley/ai/testing";

import { testConfig } from "@/testing/layers.ts";
import { aTurn, until } from "@/testing/until.ts";
import { world } from "@/testing/world.ts";

import { Caller } from "./host.ts";
import { Sessions } from "./session.ts";
describe("Caller", () => {
  it.effect("keeps what came before its reader, then streams until it ends", () =>
    Effect.gen(function* () {
      const caller = new Caller();
      caller.push("early ");
      const reading = yield* Effect.forkChild(Stream.mkString(caller.words));
      caller.push("late");
      caller.end();
      caller.push("after the end");
      expect(yield* Fiber.join(reading)).toBe("early late");
    }),
  );

  it.effect("fails its reader with what failed it, as the cause", () =>
    Effect.gen(function* () {
      const caller = new Caller();
      caller.push("partly");
      caller.fail(new Error("no model"));
      const read = yield* Effect.flip(Stream.mkString(caller.words));
      expect(read).toMatchObject({ _tag: "NotAnswered", message: "no model", cause: new Error("no model") });
    }),
  );
});

describe("AgentHost", () => {
  it.live("says each answer once, whole, while the caller gets its words as they grow", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { llm } = scriptedLLM([answer([text("我看一下"), toolCall("missing", {})]), answer("看完了，一切正常")]);
      const said: string[] = [];
      const states: string[] = [];
      const host = yield* sessions.host({
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
        say: (_route, words) => Effect.sync(() => void said.push(words)),
        state: (s, route) => Effect.sync(() => void states.push(route ? `${s} ${route}` : s)),
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
        notice: () => Effect.void,
      });
      const caller = new Caller();
      const heard: string[] = [];
      const reading = yield* Effect.forkChild(Stream.runForEach(caller.words, (w) => Effect.sync(() => void heard.push(w))));
      const result = yield* host.submit(() => Effect.succeed({ text: "看看" }), { route: "r", run: { by: { kind: "" } }, caller }, true);
      expect(result.ok).toBe(true);
      yield* until(() => states.at(-1) === "listening" && said.length === 2, "the run settled");
      yield* Fiber.join(reading);
      expect(said).toEqual(["我看一下", "看完了，一切正常"]);
      // A character at a time from the script: more pushes than answers.
      expect(heard.length).toBeGreaterThan(2);
      expect(heard.join("")).toBe("我看一下\n看完了，一切正常\n");
      // Where it works is said once it takes the input, and kept until it is done.
      expect(states.filter((s, i) => s !== states[i - 1])).toEqual([
        "thinking",
        "thinking r",
        "speaking r",
        "thinking r",
        "speaking r",
        "thinking r",
        "listening",
      ]);
      yield* host.close;
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });

  it.live("waits for an input build before closing, without delivering it late", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const { llm } = scriptedLLM();
      const host = yield* sessions.host({
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
        say: () => Effect.void,
        state: () => Effect.void,
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
        notice: () => Effect.void,
      });
      const building = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const caller = new Caller();
      const submitting = yield* Effect.forkChild(
        host.submit(
          () => Effect.as(Effect.andThen(Deferred.succeed(building, undefined), Deferred.await(gate)), { text: "late" }),
          { route: "late", run: { by: { kind: "" } }, caller },
          true,
        ),
      );
      yield* Deferred.await(building);
      const closing = yield* Effect.forkChild(host.close);
      // A close that did not wait for the build would have ended by the next turn.
      yield* aTurn;
      expect(closing.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(submitting);
      expect(result.ok).toBe(false);
      yield* Fiber.join(closing);
      // Every later close waits for the one close, which is over.
      yield* host.close;
      expect(host.current().route).toBe("first");
      expect(yield* Stream.mkString(caller.words)).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });
});
