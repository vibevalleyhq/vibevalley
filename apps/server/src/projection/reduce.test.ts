import { expect, it } from "vite-plus/test";

import type { FactCallChanged, Issue, Session } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { emptySpaceState } from "#/core/core.ts";

import { reduce } from "./reduce.ts";

it("a fact that changes neither issues nor sessions leaves the issues' statuses alone", () => {
  const issue = { id: "t1", status: "in_review", sessions: [], stage: { state: "reviewing", acts: [] } } as unknown as Issue;
  const state = { ...emptySpaceState(), issues: [issue] };
  const fact: FactCallChanged = { type: "callChanged", at: 1, state: "live", reason: "x" };
  const [next, changed] = reduce(state, fact);
  expect(changed).toBe(true);
  expect(next.issues).toBe(state.issues);
  expect(next.sessions).toBe(state.sessions);
});

it("regression: connection facts update only their server and reset only their session", () => {
  const session: Session = {
    id: sessionId("w1"),
    role: "worker",
    name: "worker",
    agent: "lab",
    runtime: "codex",
    brief: "work",
    hiredAt: 1,
    runs: 2,
    phase: { _tag: "working", since: 1, doing: { action: "thinking", label: "" } },
    refining: false,
  };
  const initial = { ...emptySpaceState(), sessions: [session] };
  const [failed] = reduce(initial, { type: "sessionToolChanged", at: 2, id: session.id, connection: { server: "farm", status: "failed", reason: "refused" } });
  const [other] = reduce(failed, { type: "sessionToolChanged", at: 3, id: session.id, connection: { server: "other", status: "ready" } });
  const [ready] = reduce(other, { type: "sessionToolChanged", at: 4, id: session.id, connection: { server: "farm", status: "ready" } });
  expect(ready.sessions[0]).toEqual({
    ...session,
    toolConnections: [
      { server: "other", status: "ready" },
      { server: "farm", status: "ready" },
    ],
  });
  expect(ready.sessions[0]?.phase).toBe(session.phase);
  const [reset] = reduce(ready, { type: "sessionToolsReset", at: 5, id: session.id });
  expect(reset.sessions[0]).toEqual({ ...session, toolConnections: [] });
  expect(reduce(initial, { type: "sessionToolChanged", at: 6, id: sessionId("missing"), connection: { server: "farm", status: "failed" } })).toEqual([
    initial,
    false,
  ]);
});

it("pure doing updates during a working phase leave issues untouched", () => {
  const session: Session = {
    id: sessionId("w1"),
    role: "worker",
    name: "worker",
    agent: "lab",
    runtime: "codex",
    brief: "work",
    issue: "t1",
    hiredAt: 1,
    runs: 1,
    phase: { _tag: "working", since: 10, doing: { action: "thinking", label: "" } },
    refining: false,
  };
  const issue = {
    id: "t1",
    status: "in_progress",
    deliver: "change",
    createdAt: 1,
    questions: [],
    findings: [],
    assignments: [{ id: "a1", agent: "lab", assignedAt: 1, executions: [{ id: "e1", executor: "w1", startedAt: 1 }] }],
    stage: { state: "working", since: 10, acts: [] },
    moves: [],
  } as unknown as Issue;
  const initial = { ...emptySpaceState(), sessions: [session], issues: [issue] };
  const [next, changed] = reduce(initial, {
    type: "sessionPhaseChanged",
    at: 20,
    id: session.id,
    phase: { _tag: "working", since: 10, doing: { action: "read_file", label: "src/app.ts" } },
  });
  expect(changed).toBe(true);
  expect(next.issues).toBe(initial.issues);
});
