import { describe, expect, it } from "vite-plus/test";
import type { Fact, Issue, IssueStatus, Session } from "@vibevalley/protocol";
import { emptyWorkspaceState } from "@/core/core.ts";
import { attentionOf } from "./attention.ts";
import { nextSteps, statusMove, statusMoves } from "./moves.ts";
import { reduce } from "@/projection/reduce.ts";
import { sessionId } from "@vibevalley/protocol/schema";
describe("status moves", () => {
  const issue = (status: IssueStatus, sent: boolean, more: Partial<Issue> = {}) =>
    ({ status, sessions: sent ? ["w1"] : [], attention: { state: "reviewing", acts: [] }, ...more }) as Issue;
  it("where each status may go", () => {
    for (const [from, sent, to] of [
      ["backlog", false, ["todo", "canceled"]],
      ["todo", false, ["backlog", "canceled"]],
      ["in_progress", true, ["canceled"]],
      ["in_review", true, ["todo", "done", "canceled"]],
      ["done", true, ["todo"]],
      ["canceled", true, ["todo"]],
      ["canceled", false, ["backlog"]],
    ] as const) {
      const t = issue(from, sent);
      expect(statusMoves(t), from).toEqual(to);
      for (const s of ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const) {
        const [m, why] = statusMove(t, s);
        expect(m !== "none" || why !== "").toBe(true);
      }
    }
    expect(statusMoves(issue("backlog", false, { refining: { session: sessionId("w2"), name: "试验田" } }))).toEqual(["canceled"]);
    expect(statusMoves(issue("in_progress", false, { lastRun: { startedAt: 1 } }))).toEqual(["canceled"]);
    expect(statusMoves(issue("in_review", false, { graph: { state: "draft" } as never }))).toEqual([]);
  });

  it("a round that failed is not completed, from the board, the command line or the orchestrator alike", () => {
    const failed = issue("in_review", true, { attention: { state: "stuck", stuck: "failed", acts: [] } });
    expect(statusMoves(failed)).toEqual(["todo", "canceled"]);
    expect(statusMove(failed, "done")).toEqual(["none", "这一轮没做成：带句话再干一轮，或者关掉"]);
    expect(statusMoves(issue("in_review", true, { attention: { state: "stuck", stuck: "interrupted", acts: [] } }))).toEqual(["todo", "done", "canceled"]);
  });

  it("an issue run by no session goes by the same table", () => {
    const ran = (status: IssueStatus, more: Partial<Issue>) => issue(status, false, { lastRun: { startedAt: 1, endedAt: 2, outcome: "completed" }, ...more });
    expect(statusMoves(ran("in_review", {}))).toEqual(["todo", "done", "canceled"]);
    expect(statusMove(ran("in_review", {}), "done")).toEqual(["complete", ""]);
    expect(statusMoves(ran("in_review", { attention: { state: "stuck", stuck: "failed", acts: [] } }))).toEqual(["todo", "canceled"]);
    expect(statusMoves(ran("done", { delivered: "none" }))).toEqual(["todo"]);
    expect(statusMoves(ran("canceled", { canceled: "dismissed" }))).toEqual(["todo"]);
  });
});

describe("moves and the attention", () => {
  const session = (lastRun: "completed" | "failed" | "interrupted") =>
    ({ id: "w1", phase: { _tag: "done" }, lastRun: { outcome: lastRun, summary: "", at: 1 } }) as unknown as Session;
  const base = { status: "in_review", sessions: ["w1"], questions: [], findings: [], createdAt: 0 } as unknown as Issue;
  const answeredSession = {
    ...session("completed"),
    lastRun: { outcome: "completed", summary: "", at: 1, answer: { conclusion: "慢在读配置", evidence: ["clock.ts:1"], unsure: [], next: [] } },
  } as Session;
  it("an answer issue waits on a conclusion it can read", () => {
    const answerIssue = { ...base, deliver: "answer" } as Issue;
    expect(attentionOf(answerIssue, session("completed"))).toMatchObject({ state: "stuck", stuck: "failed", lead: "cure" });
    const answered = attentionOf(answerIssue, answeredSession);
    expect([answered.state, answered.lead, answered.acts.map((a) => a.act)]).toEqual(["reviewing", "acknowledge", ["acknowledge", "reject", "tell", "close"]]);
    expect(attentionOf({ ...base, deliver: "change" }, session("completed"))).toMatchObject({ state: "reviewing", lead: "complete" });
  });
  it("a button that moves is a move the table allows, and done is offered exactly when the move to done is", () => {
    const cases: [Partial<Issue>, Session | undefined][] = [
      [{}, session("completed")],
      [{}, session("failed")],
      [{}, session("interrupted")],
      [{ reviewedAt: 5 }, session("completed")],
      [{ deliver: "branch" }, session("completed")],
      [{ deliver: "answer" }, session("completed")],
      [{ deliver: "answer" }, answeredSession],
      [{ sessions: [], deliver: "answer", lastRun: { startedAt: 1, endedAt: 2, outcome: "completed" } }, undefined],
      [{ sessions: [], deliver: "answer", lastRun: { startedAt: 1, endedAt: 2, outcome: "failed" } }, undefined],
      [{ sessions: [], deliver: "answer", lastRun: { startedAt: 1, endedAt: 2, outcome: "interrupted" } }, undefined],
    ];
    for (const [more, s] of cases) {
      const t = { ...base, ...more };
      const attention = attentionOf(t, s);
      const moves = statusMoves({ ...t, attention });
      const offered = attention.acts.some((a) => a.does === "move" && a.status === "done");
      expect({ more, offered }).toEqual({ more, offered: moves.includes("done") });
      for (const a of attention.acts) if (a.does === "move") expect({ more, act: a.act, allowed: moves.includes(a.status) }).toMatchObject({ allowed: true });
    }
  });

  it("change in reduce when the round fails, before the server publishes the issue", () => {
    const hired = {
      id: "w1",
      name: "阿狐",
      agent: "lab",
      runtime: "pi",
      brief: "写打卡",
      hiredAt: 1,
      runs: 1,
      issue: "t1",
      phase: { _tag: "working", since: 1, doing: { action: "none", label: "" } },
      refining: false,
    } as unknown as Session;
    const issue = {
      ...base,
      id: "t1",
      number: 1,
      title: "写打卡",
      priority: "medium",
      status: "in_progress",
      moves: ["canceled"],
      attention: { state: "working", acts: [] },
    } as unknown as Issue;
    let state = emptyWorkspaceState();
    for (const fact of [
      { type: "hired", at: 1, session: hired },
      { type: "issue", at: 1, issue },
      { type: "report", questions: [], checks: [], at: 2, id: "w1", outcome: "completed", summary: "做完了", runs: 1 },
    ] as Fact[])
      state = reduce(state, fact)[0];
    expect(state.issues[0]!.moves).toContain("done");
    state = reduce(state, { type: "report", questions: [], checks: [], at: 3, id: sessionId("w1"), outcome: "failed", summary: "没做成", runs: 2 })[0];
    expect(state.issues[0]!.moves).toEqual(["todo", "canceled"]);
  });
});

describe("next steps after a refusal", () => {
  it("are the issue's buttons and the moves they leave out as commands; one that needs words says so and runs nothing", () => {
    const t = {
      number: 41,
      status: "in_review",
      sessions: ["w1"],
      attention: {
        state: "reviewing",
        lead: "complete",
        acts: [
          { act: "complete", does: "move", status: "done", words: "none" },
          { act: "tell", does: "say" },
          { act: "stop", does: "stop" },
          { act: "close", does: "move", status: "canceled", words: "none" },
        ],
      },
    } as unknown as Issue;
    const next = nextSteps(t);
    expect(next.filter((n) => n.run).map((n) => n.run)).toEqual([
      ["issue", "status", "update", "41", "--json", '{"status":"done"}'],
      ["session", "stop", "w1"],
      ["issue", "status", "update", "41", "--json", '{"status":"canceled"}'],
    ]);
    expect(next.filter((n) => !n.run).map((n) => n.say)).toEqual([
      "带话：issue comment create 41，--json 带要说的 text",
      "挪到待办：issue status update 41，--json 带 status「todo」和这一轮要它做什么的 text",
    ]);
  });
});
