import { getEventListeners } from "node:events";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { world } from "../testing/world.ts";
import { AgentExecution } from "./execution.ts";
import { Caller } from "./host.ts";
import { type RunFinished, type RunStore, Sessions, type SessionsInside } from "./session.ts";

const user = (text: string) => ({ type: "message_start", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } }) as AgentEvent;
const said = (text: string, stopReason = "stop", errorMessage?: string) =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想" },
        { type: "text", text },
      ],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  }) as unknown as AgentEvent;
const end = (stopReason = "stop") => ({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason }] }) as unknown as AgentEvent;
const tool = (id: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "issue_list", args: {} }) as AgentEvent;
const toolEnd = (id: string) =>
  ({ type: "tool_execution_end", toolCallId: id, toolName: "issue_list", result: { content: [{ type: "text", text: "两张" }] }, isError: false }) as AgentEvent;

const issue = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`insert into issue (id, number, title, description, created_at) values (${id}, ${Number(id.slice(1))}, ${id}, '', 0)`.pipe(Effect.orDie),
  );

describe("the orchestrator's runs", () => {
  it.live("one loop is one run; its inputs' issues are all linked; failures and stops are said", () =>
    Effect.gen(function* () {
      const sessions = (yield* Sessions) as SessionsInside;
      yield* issue("i1");
      yield* issue("i2");
      const finished: RunFinished[] = [];
      const following = yield* Effect.forkScoped(Stream.runForEach(yield* sessions.finishedRuns, (r) => Effect.sync(() => finished.push(r))));
      yield* Effect.sleep(5);
      const journal = sessions.trajectories.openLog("orchestrator");
      const x = new AgentExecution("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), sessions.runStore);

      yield* x.observe(user("看看工单"), { issue: "i1", by: { kind: "issue" }, heard: ["m1"] });
      expect(sessions.currentRun("orchestrator")).not.toBe("");
      yield* x.observe(tool("c1"));
      yield* x.observe(toolEnd("c1"));
      yield* x.observe(user("再看一张"), { issue: "i2", by: { kind: "comment" } });
      yield* x.observe(said("看完了"));
      yield* x.observe(end());
      expect(sessions.currentRun("orchestrator")).toBe("");
      expect(finished).toEqual([{ id: expect.any(String), issues: ["i1", "i2"], outcome: "completed" }]);
      const runs = yield* sessions.runs("i2");
      expect(runs.map((r) => [r.issue, r.outcome, r.summary, r.heard])).toEqual([["i1", "completed", "看完了", ["m1"]]]);
      expect(journal.events().map((e) => e.type)).toEqual([
        "run/start",
        "user/message",
        "tool/call",
        "tool/result",
        "user/message",
        "assistant/thinking",
        "assistant/message",
        "run/end",
      ]);

      yield* x.observe(user("再来"), { by: { kind: "comment" } });
      yield* x.observe(said("", "error", "429 太多了"));
      yield* x.observe(end());
      expect(finished.at(-1)!.outcome).toBe("failed");

      yield* x.observe(user("停"), { by: { kind: "comment" } });
      yield* x.observe(end("aborted"));
      expect(finished.at(-1)!.outcome).toBe("interrupted");

      const failed = yield* x.failedStart({ by: { kind: "issue" }, issue: "i1" }, "派不出去的", "钥匙没填");
      expect((yield* sessions.runs("i1")).find((r) => r.id === failed)?.outcome).toBe("failed");
      yield* Fiber.interrupt(following);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("close takes effect only when run and stops later inputs", () =>
    Effect.gen(function* () {
      const sessions = (yield* Sessions) as SessionsInside;
      const journal = sessions.trajectories.openLog("orchestrator");
      const x = new AgentExecution("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), sessions.runStore);
      const closing = x.close();
      yield* x.observe(user("还收"), { by: { kind: "comment" } });
      expect(sessions.currentRun("orchestrator")).not.toBe("");
      yield* closing;
      expect(sessions.currentRun("orchestrator")).toBe("");
      yield* x.observe(user("不再收"), { by: { kind: "comment" } });
      expect(sessions.currentRun("orchestrator")).toBe("");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ outcome: string; summary: string }>`select outcome, summary from session_run`;
      expect(rows).toEqual([{ outcome: "interrupted", summary: "VibeValley 停下了，这一轮中断了" }]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("a run whose end could not be written ends before the next starts", () =>
    Effect.gen(function* () {
      const sessions = (yield* Sessions) as SessionsInside;
      let broken = true;
      const store: RunStore = { ...sessions.runStore, finish: (...a) => (broken ? Effect.fail(new Error("disk full")) : sessions.runStore.finish(...a)) };
      const x = new AgentExecution("orchestrator", sessions.trajectories.openLog("orchestrator"), (tool) => ({ text: tool, action: "other", tool }), store);
      yield* x.observe(user("一"), { by: { kind: "comment" } });
      const first = sessions.currentRun("orchestrator");
      expect(yield* Effect.flip(x.observe(end()))).toBeInstanceOf(Error);
      expect(sessions.currentRun("orchestrator")).toBe("");
      broken = false;
      yield* x.observe(user("二"), { by: { kind: "comment" } });
      const second = sessions.currentRun("orchestrator");
      expect(second).not.toBe(first);
      yield* x.observe(end());
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ id: string; outcome: string }>`select id, outcome from session_run order by started_at`;
      expect(rows.map((r) => r.outcome)).toEqual(["completed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );
});

describe("a caller's words", () => {
  const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;
  const pending = async (words: AsyncGenerator<string>, signal: AbortSignal) => {
    const next = words.next();
    await Promise.resolve();
    expect(listeners(signal)).toBeGreaterThan(0);
    return { next };
  };

  it("does not accumulate abort listeners over 20 empty waits and pushes", async () => {
    const controller = new AbortController();
    const caller = new Caller();
    const words = caller.words(controller.signal);
    for (let i = 0; i < 20; i++) {
      const { next } = await pending(words, controller.signal);
      caller.push(`w${i}`);
      expect(await next).toEqual({ done: false, value: `w${i}` });
    }
    expect(listeners(controller.signal)).toBe(0);
    await words.return(undefined);
  });

  it("cleans the abort listener after end and an early return", async () => {
    const ending = new AbortController();
    const ended = new Caller();
    const endedWords = ended.words(ending.signal);
    const { next: end } = await pending(endedWords, ending.signal);
    ended.end();
    expect(await end).toEqual({ done: true, value: undefined });
    expect(listeners(ending.signal)).toBe(0);

    const returning = new AbortController();
    const caller = new Caller();
    const words = caller.words(returning.signal);
    const { next } = await pending(words, returning.signal);
    const returned = words.return(undefined);
    expect(await next).toEqual({ done: true, value: undefined });
    expect(await returned).toEqual({ done: true, value: undefined });
    expect(listeners(returning.signal)).toBe(0);
  });

  it("abort wakes an empty wait and cleans its listener", async () => {
    const controller = new AbortController();
    const caller = new Caller();
    const words = caller.words(controller.signal);
    const { next } = await pending(words, controller.signal);
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(listeners(controller.signal)).toBe(0);
  });
});
