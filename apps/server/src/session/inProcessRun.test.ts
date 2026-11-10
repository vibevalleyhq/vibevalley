import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import type { CoreEvent } from "@vibevalley/agent/brain";
import type { StopReason } from "@vibevalley/ai/messages";
import { assistantMessage, text, thinking } from "@vibevalley/ai/testing";

import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { world } from "#/testing/world.ts";
import * as qs from "#db/session.sql.ts";

import { makeInProcessRun, NotRecorded, recording } from "./inProcessRun.ts";
import { makeTrajectories } from "./journal.ts";
import { type RunFinished, type RunStore, runOf, Session } from "./session.ts";
const user = (words: string): CoreEvent => ({ type: "message_start", message: { role: "user", content: [text(words)], timestamp: 0 } });
const said = (words: string, stopReason: StopReason = "stop", errorMessage?: string): CoreEvent => ({
  type: "message_end",
  message: assistantMessage([thinking("想"), text(words)], { stopReason, ...(errorMessage ? { errorMessage } : {}) }),
});
const end = (stopReason: StopReason = "stop"): CoreEvent => ({ type: "agent_end", messages: [assistantMessage([], { stopReason })] });
const tool = (id: string): CoreEvent => ({ type: "tool_execution_start", toolCallId: id, toolName: "issue_list", args: {} });
const toolEnd = (id: string): CoreEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "issue_list",
  result: { content: [text("两张")] },
  isError: false,
});

const issue = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`insert into issue
      (id, number, title, description, created_at, mandate_strength, max_bot_review_rounds, auto_submit_pr)
      values (${id}, ${Number(id.slice(1))}, ${id}, '', 0, 'explicit', 3, false)`.pipe(Effect.orDie),
  );

const records = Effect.gen(function* () {
  const config = yield* ServerConfig;
  yield* (yield* Db).run(
    qs.keepSession({
      id: "orchestrator",
      role: "orchestrator",
      agent: "orchestrator",
      name: "助手",
      runtime: "vibevalley",
      brief: "",
      repo: null,
      issue: null,
      channel: null,
      hired_at: 0,
      machine: null,
    }),
  );
  const trajectories = yield* makeTrajectories(config.home, () => {});
  const persisted = yield* recording;
  const finished: RunFinished[] = [];
  let current = () => "";
  const store: RunStore = {
    ...persisted,
    finished: (run) => void finished.push(run),
    consumed: () => {},
    register: (_session, read) => {
      current = read;
    },
  };
  return { store, finished, journal: yield* trajectories.openLog("orchestrator"), currentRun: () => current() };
});

describe("the orchestrator's runs", () => {
  it.live("one loop is one run; its inputs' issues are all linked; failures and stops are said", () =>
    Effect.gen(function* () {
      const sessions = yield* Session;
      yield* issue("i1");
      yield* issue("i2");
      const { store, finished, journal, currentRun } = yield* records;
      const x = yield* makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);

      yield* x.observe(user("看看工单"), { issue: "i1", by: { kind: "issue", channel: "general", message: "m1" }, heard: ["m1"] });
      expect(currentRun()).not.toBe("");
      yield* x.observe(tool("c1"));
      yield* x.observe(toolEnd("c1"));
      yield* x.observe(user("再看一张"), { issue: "i2", by: { kind: "comment" } });
      yield* x.observe(said("看完了"));
      yield* x.observe(end());
      expect(currentRun()).toBe("");
      expect(finished).toHaveLength(1);
      expect(finished).toEqual([{ id: expect.any(String), issues: ["i1", "i2"], outcome: "completed" }]);
      const runs = yield* sessions.issueRuns("i2");
      expect(runs[0]?.triggeredBy).toEqual({ kind: "issue", channel: "general", message: "m1" });
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
      expect(finished).toHaveLength(2);
      expect(finished.at(-1)!.outcome).toBe("failed");

      yield* x.observe(user("停"), { by: { kind: "comment" } });
      yield* x.observe(end("aborted"));
      expect(finished).toHaveLength(3);
      expect(finished.at(-1)!.outcome).toBe("interrupted");

      const failed = yield* x.failedStart({ by: { kind: "issue" }, issue: "i1" }, "派不出去的", "钥匙没填");
      expect((yield* sessions.issueRuns("i1")).find((r) => r.id === failed)?.outcome).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("close changes execution only when its effect runs", () =>
    Effect.gen(function* () {
      const { store, journal, currentRun } = yield* records;
      const x = yield* makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);
      const closing = x.close;
      yield* x.observe(user("still accepted"), { by: { kind: "comment" } });
      expect(currentRun()).not.toBe("");
      yield* closing;
      expect(currentRun()).toBe("");
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
      const { store: persisted, journal, currentRun } = yield* records;
      let broken = true;
      const store: RunStore = {
        ...persisted,
        finish: (...a) => (broken ? Effect.fail(NotRecorded.make({ message: "disk full" })) : persisted.finish(...a)),
      };
      const x = yield* makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);
      yield* x.observe(user("一"), { by: { kind: "comment" } });
      const first = currentRun();
      const observeFailure = yield* Effect.flip(x.observe(end()));
      expect(observeFailure).toBeInstanceOf(NotRecorded);
      expect(currentRun()).toBe("");
      broken = false;
      yield* x.observe(user("二"), { by: { kind: "comment" } });
      const second = currentRun();
      expect(second).not.toBe(first);
      yield* x.observe(end());
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ id: string; outcome: string }>`select id, outcome from session_run order by started_at`;
      expect(rows.map((r) => r.outcome)).toEqual(["completed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );
});
