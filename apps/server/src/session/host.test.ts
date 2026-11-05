import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer, text, toolCall } from "@vibevalley/ai/testing";

import { owner } from "#/base/actor.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { Memory } from "#/memory/memory.ts";
import { testConfig, aTurn, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as qs from "#db/session.sql.ts";

import { Caller } from "./host.ts";
import { Session, type RunFinished } from "./session.ts";
import type { InputConsumed } from "./signals.ts";
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
      const sessions = yield* Session;
      const { llm, requests } = scriptedLLM([
        answer([text("我看一下"), toolCall("remember", { note: "remembered in database" }), toolCall("missing", {})]),
        answer("看完了，一切正常"),
      ]);
      const memory = yield* Memory;
      yield* memory.remember({ agent: "orchestrator", text: "database preference", project: "", by: owner });
      const finished: RunFinished[] = [];
      const consumed: InputConsumed[] = [];
      const answeringRuns: (string | undefined)[] = [];
      yield* Effect.forkScoped(Stream.runForEach(yield* sessions.finishedRuns, (run) => Effect.sync(() => void finished.push(run))));
      yield* Effect.forkScoped(Stream.runForEach(yield* sessions.inputsConsumed, (input) => Effect.sync(() => void consumed.push(input))));
      const said: string[] = [];
      const states: string[] = [];
      const core = yield* Core;
      yield* Effect.forkScoped(
        Stream.runForEach(yield* core.subscribe, () =>
          Effect.sync(() => {
            const session = core.session("orchestrator");
            if (!session) return;
            const phase = session.phase;
            states.push(phase._tag === "working" ? `${phase.doing.action}${session.channel ? " " + session.channel : ""}` : phase._tag);
          }),
        ),
      );
      const host = yield* sessions.host({
        session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "管家", runtime: "vibevalley", brief: "" },
        inputType: "testInput",
        home: config.home,
        cwd: config.workRoot,
        instructions: "",
        llm: () => llm,
        tools: () => [],
        first: "first",
        quiet: () => false,
        say: (_route, words) =>
          Effect.sync(() => {
            said.push(words);
            answeringRuns.push(sessions.runOf("orchestrator"));
          }),
        channel: (route) => route,
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
      });
      const kept = yield* (yield* Db).one(qs.sessionByID({ id: "orchestrator" }));
      expect(kept).toMatchObject({ id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "管家", ended_at: null });
      const caller = new Caller();
      const heard: string[] = [];
      const reading = yield* Effect.forkChild(Stream.runForEach(caller.words, (w) => Effect.sync(() => void heard.push(w))));
      const result = yield* host.submit(() => Effect.succeed({ text: "看看" }), { route: "r", run: { by: { kind: "" }, heard: ["m1"] }, caller }, true);
      expect(result.ok).toBe(true);
      yield* until(() => core.session("orchestrator")?.phase._tag === "done" && said.length === 2, "the run settled");
      yield* Fiber.join(reading);
      expect(said).toEqual(["我看一下", "看完了，一切正常"]);
      yield* until(() => finished.length === 1 && consumed.length === 1, "the public run events");
      expect(finished).toEqual([{ id: expect.any(String), issues: [], outcome: "completed" }]);
      expect(consumed).toEqual([{ session: "orchestrator", envelopeIds: ["m1"] }]);
      expect(answeringRuns).toEqual([finished[0]!.id, finished[0]!.id]);
      expect(requests[0]!.system).toContain("database preference");
      expect((yield* memory.list("orchestrator")).some((note) => note.text === "remembered in database")).toBe(true);
      expect(existsSync(join(config.home, "MEMORY.md"))).toBe(false);
      expect(sessions.runOf("orchestrator")).toBeUndefined();
      // A character at a time from the script: more pushes than answers.
      expect(heard.length).toBeGreaterThan(2);
      expect(heard.join("")).toBe("我看一下\n看完了，一切正常\n");
      // Where it works is said once it takes the input, and kept until it is done.
      expect(states).toContain("thinking r");
      expect(states).toContain("speaking_text r");
      expect(core.session("orchestrator")).toMatchObject({ role: "orchestrator", phase: { _tag: "done" }, runs: 1 });
      yield* host.close;
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });

  it.live("waits for an input build before closing, without delivering it late", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const { llm } = scriptedLLM();
      const host = yield* sessions.host({
        session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "管家", runtime: "vibevalley", brief: "" },
        inputType: "testInput",
        home: config.home,
        cwd: config.workRoot,
        instructions: "",
        llm: () => llm,
        tools: () => [],
        first: "first",
        quiet: () => true,
        say: () => Effect.void,
        channel: () => undefined,
        fresh: () => {},
        restored: () => ({ by: { kind: "" } }),
        toolStart: (tool) => ({ text: tool, action: "other", tool }),
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
