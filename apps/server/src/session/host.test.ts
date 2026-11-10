import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer, text, toolCall } from "@vibevalley/ai/testing";

import { user } from "#/base/actor.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { Memory } from "#/memory/memory.ts";
import { testConfig, aTurn, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";
import * as qs from "#db/session.sql.ts";

import { Caller } from "./host.ts";
import { Session } from "./session.ts";
import type { SessionNews } from "./signals.ts";
describe("Caller", () => {
  it.effect("keeps what came before its reader, then streams until it ends", () =>
    Effect.gen(function* () {
      const caller = new Caller();
      caller.push("early ");
      const reading = yield* Effect.forkChild(Stream.mkString(caller.words));
      caller.push("late");
      caller.end();
      caller.push("after the end");
      const reading2 = yield* Fiber.join(reading);
      expect(reading2).toBe("early late");
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
  it.effect("ended before its reader, still hands over what it kept, once", () =>
    Effect.gen(function* () {
      const caller = new Caller();
      caller.push("kept");
      caller.end();
      caller.fail(new Error("too late"));
      const mkString2 = yield* Stream.mkString(caller.words);
      expect(mkString2).toBe("kept");
      const mkString3 = yield* Stream.mkString(caller.words);
      expect(mkString3).toBe("");
    }),
  );

  it.effect("failed while streaming, the reader gets the words before the failure", () =>
    Effect.gen(function* () {
      const caller = new Caller();
      const heard: string[] = [];
      const reading = yield* Effect.forkChild(
        Stream.runForEach(caller.words, (w) => Effect.sync(() => void heard.push(w))),
        { startImmediately: true },
      );
      caller.push("partly");
      caller.fail(new Error("no model"));
      caller.end();
      const readingFailure = yield* Effect.flip(Fiber.join(reading));
      expect(readingFailure).toMatchObject({ _tag: "NotAnswered", message: "no model" });
      expect(heard).toEqual(["partly"]);
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
      yield* memory.remember({ agent: "orchestrator", text: "database preference", repo: "", by: user });
      const finished: Extract<SessionNews, { _tag: "RunFinished" }>[] = [];
      const consumed: Extract<SessionNews, { _tag: "Consumed" }>[] = [];
      const answeringRuns: (string | undefined)[] = [];
      const news = yield* sessions.news;
      yield* Effect.forkScoped(
        Stream.runForEach(news, (n) =>
          Effect.sync(() => {
            if (n._tag === "RunFinished") finished.push(n);
            else if (n._tag === "Consumed") consumed.push(n);
          }),
        ),
      );
      const said: string[] = [];
      const states: string[] = [];
      const core = yield* Core;
      const subscribe2 = yield* core.subscribe;
      yield* Effect.forkScoped(
        Stream.runForEach(subscribe2, () =>
          Effect.sync(() => {
            const session = core.session("orchestrator");
            if (!session) return;
            const phase = session.phase;
            states.push(phase._tag === "working" ? `${phase.doing.action}${session.channel ? " " + session.channel : ""}` : phase._tag);
          }),
        ),
      );
      const host = yield* sessions.host({
        session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
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
      expect(kept).toMatchObject({ id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", ended_at: null });
      const caller = new Caller();
      const heard: string[] = [];
      const reading = yield* Effect.forkChild(Stream.runForEach(caller.words, (w) => Effect.sync(() => void heard.push(w))));
      const result = yield* host.submit(() => Effect.succeed({ text: "看看" }), { route: "r", run: { by: { kind: "" }, heard: ["m1"] }, caller }, true);
      expect(result.ok).toBe(true);
      yield* until(() => core.session("orchestrator")?.phase._tag === "done" && said.length === 2, "the run settled");
      yield* Fiber.join(reading);
      expect(said).toEqual(["我看一下", "看完了，一切正常"]);
      yield* until(() => finished.length === 1 && consumed.length === 1, "the public run events");
      expect(finished).toEqual([{ _tag: "RunFinished", id: expect.any(String), issues: [], outcome: "completed" }]);
      expect(consumed).toEqual([{ _tag: "Consumed", session: "orchestrator", envelopeIds: ["m1"] }]);
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
        session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
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
      const mkString2 = yield* Stream.mkString(caller.words);
      expect(mkString2).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });
  it.live("regression: a later close still waits for the cleanup when the first closing caller is interrupted", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const { llm } = scriptedLLM();
      const host = yield* sessions.host({
        session: { id: "orchestrator", role: "orchestrator", agent: "orchestrator", name: "助手", runtime: "vibevalley", brief: "" },
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
      yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
      const submitting = yield* Effect.forkChild(
        host.submit(
          () => Effect.as(Effect.andThen(Deferred.succeed(building, undefined), Deferred.await(gate)), { text: "late" }),
          { route: "late", run: { by: { kind: "" } } },
          true,
        ),
      );
      yield* Deferred.await(building);
      const first = yield* Effect.forkChild(host.close, { startImmediately: true });
      yield* Fiber.interrupt(first);
      const second = yield* Effect.forkChild(host.close, { startImmediately: true });
      yield* aTurn;
      expect(second.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(submitting)).ok).toBe(false);
      yield* Fiber.join(second);
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });
});
