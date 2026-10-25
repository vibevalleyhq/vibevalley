import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { world } from "../testing/world.ts";
import { AgentExecution } from "./execution.ts";
import { type RunFinished, type RunStore, runOf, Sessions, type SessionsInside } from "./session.ts";

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

  it.live("close changes execution only when its effect runs", () =>
    Effect.gen(function* () {
      const sessions = (yield* Sessions) as SessionsInside;
      const x = new AgentExecution(
        "orchestrator",
        sessions.trajectories.openLog("orchestrator"),
        (tool) => ({ text: tool, action: "other", tool }),
        sessions.runStore,
      );
      const closing = x.close();
      yield* x.observe(user("still accepted"), { by: { kind: "comment" } });
      expect(sessions.currentRun("orchestrator")).not.toBe("");
      yield* closing;
      expect(sessions.currentRun("orchestrator")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it("restores each persisted run field by its own schema", () => {
    const row = {
      id: "r1",
      session: "w1",
      triggered_by: `{"kind":"runtime"}`,
      heard: null,
      started_at: 0,
      ended_at: null,
      outcome: null,
      summary: null,
      issue: null,
      spent: null,
    } satisfies Parameters<typeof runOf>[0];
    const valid = runOf({ ...row, triggered_by: `{"kind":"issue","message":"继续"}`, heard: `["m1"]`, spent: `{"tokens":3,"cny":0.5}` });
    expect([valid.triggeredBy, valid.heard, valid.spent]).toEqual([{ kind: "issue", message: "继续" }, ["m1"], { tokens: 3, cny: 0.5 }]);
    const invalid = runOf({ ...row, triggered_by: `{"kind":{}}`, heard: `{}`, spent: `{"tokens":1e999}` });
    expect([invalid.triggeredBy, invalid.heard, invalid.spent]).toEqual([{ kind: "runtime" }, [], undefined]);
  });

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
