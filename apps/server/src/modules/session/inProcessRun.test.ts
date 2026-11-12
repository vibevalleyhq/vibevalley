import { describe, expect, test } from "vite-plus/test";

import type { CoreEvent } from "@vibevalley/agent/brain";
import type { StopReason } from "@vibevalley/ai/messages";
import { assistantMessage, text, thinking } from "@vibevalley/ai/testing";

import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { world } from "#/testing/world.ts";
import * as qs from "#db/session.sql.ts";

import { makeInProcessRun, NotRecorded, recording } from "./inProcessRun.ts";
import { makeTrajectories } from "./journal.ts";
import { type RunFinished, type RunStore, runOf } from "./session.ts";
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

type Farm = Awaited<ReturnType<typeof world>>;

const issue = (farm: Farm, id: string) =>
  farm.db.sql.exec(
    `insert into issue
      (id, number, title, description, created_at, mandate_strength, max_bot_review_rounds, auto_submit_pr)
      values ($1, $2, $3, '', 0, 'explicit', 3, false)`,
    [id, Number(id.slice(1)), id],
  );

const records = async (farm: Farm) => {
  await qs.keepSession(farm.db.sql, {
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
  });
  const trajectories = makeTrajectories(farm.config.home, () => {}, { clock: wallTime, log: keptLog() });
  const persisted = recording({ db: farm.db, clock: wallTime });
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
  return { store, finished, journal: await trajectories.openLog("orchestrator"), currentRun: () => current() };
};

describe("the orchestrator's runs", () => {
  test("one loop is one run; its inputs' issues are all linked; failures and stops are said", async () => {
    await using farm = await world();
    const sessions = farm.session;
    await issue(farm, "i1");
    await issue(farm, "i2");
    const { store, finished, journal, currentRun } = await records(farm);
    const x = makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);

    await x.observe(user("看看工单"), { issue: "i1", by: { kind: "issue", channel: "general", message: "m1" }, heard: ["m1"] });
    expect(currentRun()).not.toBe("");
    await x.observe(tool("c1"));
    await x.observe(toolEnd("c1"));
    await x.observe(user("再看一张"), { issue: "i2", by: { kind: "comment" } });
    await x.observe(said("看完了"));
    await x.observe(end());
    expect(currentRun()).toBe("");
    expect(finished).toHaveLength(1);
    expect(finished).toEqual([{ id: expect.any(String), issues: ["i1", "i2"], outcome: "completed" }]);
    const runs = await sessions.issueRuns("i2");
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

    await x.observe(user("再来"), { by: { kind: "comment" } });
    await x.observe(said("", "error", "429 太多了"));
    await x.observe(end());
    expect(finished).toHaveLength(2);
    expect(finished.at(-1)!.outcome).toBe("failed");

    await x.observe(user("停"), { by: { kind: "comment" } });
    await x.observe(end("aborted"));
    expect(finished).toHaveLength(3);
    expect(finished.at(-1)!.outcome).toBe("interrupted");

    const failed = await x.failedStart({ by: { kind: "issue" }, issue: "i1" }, "派不出去的", "钥匙没填");
    expect((await sessions.issueRuns("i1")).find((r) => r.id === failed)?.outcome).toBe("failed");
  });

  test("close changes execution only when its effect runs", async () => {
    await using farm = await world();
    const { store, journal, currentRun } = await records(farm);
    const x = makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);
    const closing = x.close;
    await x.observe(user("still accepted"), { by: { kind: "comment" } });
    expect(currentRun()).not.toBe("");
    await closing();
    expect(currentRun()).toBe("");
  });

  test("restores each persisted run field by its own schema", () => {
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
    expect(() => runOf({ ...row, triggered_by: `{"kind":{}}` })).toThrow("session_run.triggered_by");
    expect(() => runOf({ ...row, heard: `{}` })).toThrow("session_run.heard");
    expect(() => runOf({ ...row, spent: `{"tokens":1e999}` })).toThrow("session_run.spent");
  });

  test("a run whose end could not be written ends before the next starts", async () => {
    await using farm = await world();
    const { store: persisted, journal, currentRun } = await records(farm);
    let broken = true;
    const store: RunStore = {
      ...persisted,
      finish: (...a) => (broken ? Promise.reject(new NotRecorded("disk full")) : persisted.finish(...a)),
    };
    const x = makeInProcessRun("orchestrator", journal, (tool) => ({ text: tool, action: "other", tool }), store);
    await x.observe(user("一"), { by: { kind: "comment" } });
    const first = currentRun();
    const observeFailure = await x.observe(end()).catch((e: unknown) => e);
    expect(observeFailure).toBeInstanceOf(NotRecorded);
    expect(currentRun()).toBe("");
    broken = false;
    await x.observe(user("二"), { by: { kind: "comment" } });
    const second = currentRun();
    expect(second).not.toBe(first);
    await x.observe(end());
    const rows = await farm.db.sql.query("select id, outcome from session_run order by started_at");
    expect(rows.map((r) => r["outcome"])).toEqual(["completed", "completed"]);
  });
});
