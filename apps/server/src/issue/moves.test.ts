// Where an issue may be moved: the table, and how it reads the attention.

import { describe, expect, it } from "vite-plus/test";
import { type Fact, type Issue, type IssueStatus, managerAgent, type Session } from "@vibevalley/protocol";
import { emptyWorkspaceState } from "../core/core.ts";
import { attentionOf } from "./attention.ts";
import { statusMove, statusMoves } from "./moves.ts";
import { reduce } from "../projection/reduce.ts";

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
    const required = issue("in_review", true, { acceptance: "required" });
    expect(statusMoves(required)).toEqual(["todo", "canceled"]);
    expect(statusMoves({ ...required, acceptedAt: 1 })).toEqual(["todo", "done", "canceled"]);
    expect(statusMoves(issue("backlog", false, { refining: { session: "w2", name: "试验田" } }))).toEqual(["canceled"]);
    expect(statusMoves(issue("in_progress", false, { assignee: managerAgent }))).toEqual([]);
    expect(statusMoves(issue("in_review", false, { graph: { state: "draft" } as never }))).toEqual([]);
  });

  it("a round that failed is not harvested, from the board, the command line or the manager alike", () => {
    const failed = issue("in_review", true, { attention: { state: "stuck", stuck: "failed", acts: [] } });
    expect(statusMoves(failed)).toEqual(["todo", "canceled"]);
    expect(statusMove(failed, "done")).toEqual(["none", "这一轮没做成：带句话再干一轮，或者关掉"]);
    // Stopped halfway is not failed: what is there may still be harvested.
    expect(statusMoves(issue("in_review", true, { attention: { state: "stuck", stuck: "interrupted", acts: [] } }))).toEqual(["todo", "done", "canceled"]);
  });

  it("the manager's issue waits on the owner once its turn ended, and only an answer is taken as done", () => {
    const manager = (more: Partial<Issue>) => issue("in_review", false, { assignee: managerAgent, ...more });
    expect(statusMoves(manager({ handedBack: { at: 1, outcome: "completed" } }))).toEqual(["done", "canceled"]);
    expect(statusMove(manager({ handedBack: { at: 1, outcome: "completed" } }), "done")).toEqual(["answered", ""]);
    expect(statusMove(manager({ handedBack: { at: 1, outcome: "completed" } }), "canceled")).toEqual(["putAway", ""]);
    for (const outcome of ["failed", "interrupted"] as const) expect(statusMoves(manager({ handedBack: { at: 1, outcome } }))).toEqual(["canceled"]);
    expect(statusMoves(issue("done", false, { assignee: managerAgent, closed: "answered" }))).toEqual([]);
  });
});

describe("moves and the attention", () => {
  const session = (lastRun: "completed" | "failed" | "interrupted") =>
    ({ id: "w1", phase: { _tag: "ripe" }, lastRun: { outcome: lastRun, summary: "", at: 1 } }) as unknown as Session;
  const base = { status: "in_review", sessions: ["w1"], questions: [], findings: [], acceptance: "glance", createdAt: 0 } as unknown as Issue;
  // One table: an act that takes the issue to done is offered exactly when the move is.
  it("agree on done, whatever the round came to", () => {
    const cases: [Partial<Issue>, Session | undefined][] = [
      [{}, session("completed")],
      [{}, session("failed")],
      [{}, session("interrupted")],
      [{ acceptance: "required" }, session("completed")],
      [{ acceptance: "required", acceptedAt: 5 }, session("completed")],
      [{ assignee: managerAgent, sessions: [], handedBack: { at: 1, outcome: "completed" } }, undefined],
      [{ assignee: managerAgent, sessions: [], handedBack: { at: 1, outcome: "failed" } }, undefined],
    ];
    for (const [more, s] of cases) {
      const t = { ...base, ...more } as Issue;
      const attention = attentionOf(t, s);
      const offered = attention.acts.some((a) => a === "harvest" || a === "acknowledge");
      expect({ more, offered }).toEqual({ more, offered: statusMoves({ ...t, attention }).includes("done") });
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
      { type: "report", at: 2, id: "w1", outcome: "completed", summary: "做完了", runs: 1 },
    ] as Fact[])
      state = reduce(state, fact)[0];
    expect(state.issues![0]!.moves).toContain("done");
    state = reduce(state, { type: "report", at: 3, id: "w1", outcome: "failed", summary: "没做成", runs: 2 } as Fact)[0];
    expect(state.issues![0]!.moves).toEqual(["todo", "canceled"]);
  });
});
