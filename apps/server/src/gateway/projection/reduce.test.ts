import { expect, it } from "vite-plus/test";

import type { Issue, IssueAnswer, Session } from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { emptySpaceState, type Fact } from "#/core/core.ts";
import { issueRefiningOf, issueStatusOf, withIssueStatuses } from "#/modules/issue/status.ts";

import { makeFrameOf } from "./frame.ts";
import { reduce } from "./reduce.ts";

it("a fact that changes neither issues nor sessions leaves the issues' statuses alone", () => {
  const issue = { id: "t1", status: "in_review", sessions: [], stage: { state: "reviewing", acts: [] } } as unknown as Issue;
  const state = { ...emptySpaceState(), issues: [issue] };
  const fact: Extract<Fact, { type: "callChanged" }> = { type: "callChanged", at: 1, state: "live", reason: "x" };
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
    scope: { kind: "issue", id: issueId("t1") },
    hiredAt: 1,
    runs: 1,
    phase: { _tag: "working", since: 10, doing: { action: "thinking", label: "" } },
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

it("each frame projector keeps its own memo slots without thrashing another farm's cache", () => {
  const first = makeFrameOf();
  const second = makeFrameOf();
  const stateA = emptySpaceState();
  const stateB = { ...emptySpaceState(), call: "live" as const };
  const frameA1 = first(stateA);
  const frameB = second(stateB);
  const frameA2 = first(stateA);
  expect(frameB.state.call).toBe("live");
  expect(frameA2.inbox).toBe(frameA1.inbox);
  expect(frameA2.view).toBe(frameA1.view);
});

const sampleIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: issueId("t1"),
  number: 1,
  title: "check logs",
  description: "",
  mandate: { strength: "explicit", maxBotReviewRounds: 2, autoSubmitPr: false },
  assignments: [{ id: "a1", issue: issueId("t1"), agent: "lab", assignedAt: 1, executions: [{ kind: "worker", session: sessionId("w1"), startedAt: 1 }] }],
  priority: "medium",
  createdAt: 1,
  blockedBy: [],
  status: "in_progress",
  moves: ["canceled"],
  deliver: "change",
  findings: [],
  questions: [],
  criteria: [],
  checks: [],
  stage: { state: "working", since: 1, acts: [] },
  ...overrides,
});

const sampleSession = (overrides: Partial<Session> = {}): Session => ({
  id: sessionId("w1"),
  role: "worker",
  name: "worker",
  agent: "lab",
  runtime: "codex",
  brief: "work",
  scope: { kind: "issue", id: issueId("t1") },
  hiredAt: 1,
  runs: 1,
  phase: { _tag: "working", since: 1, doing: { action: "thinking", label: "" } },
  ...overrides,
});

it("sessionReported keeps a resting phase only while the scoped issue's pull request is open", () => {
  const session = sampleSession();
  const openPrIssue = sampleIssue({ pullRequest: { url: "https://example.test/pr/1", number: 1, state: "open" } });
  const [restingState] = reduce(
    { ...emptySpaceState(), sessions: [session], issues: [openPrIssue] },
    {
      type: "sessionReported",
      at: 10,
      id: session.id,
      outcome: "completed",
      phase: { _tag: "resting" },
      summary: "submitted",
      runs: 1,
      questions: [],
      checks: [],
    },
  );
  expect(restingState.sessions[0]?.phase).toEqual({ _tag: "resting" });
  expect(restingState.issues[0]?.status).toBe("in_progress");

  const mergedPrIssue = sampleIssue({ pullRequest: { url: "https://example.test/pr/1", number: 1, state: "merged" } });
  const [doneState] = reduce(
    { ...emptySpaceState(), sessions: [session], issues: [mergedPrIssue] },
    { type: "sessionReported", at: 10, id: session.id, outcome: "completed", phase: { _tag: "resting" }, summary: "done", runs: 1, questions: [], checks: [] },
  );
  expect(doneState.sessions[0]?.phase).toEqual({ _tag: "done" });
  expect(doneState.issues[0]?.status).toBe("in_review");
});

it("sessionReported folds an answer only for the answer issue's latest completed session, and status/refining stay aligned with lookup", () => {
  const answer: IssueAnswer = { conclusion: "all clear", evidence: ["e1"], unsure: [], next: [] };
  const older = sampleSession({ id: sessionId("w0") });
  const latest = sampleSession({ id: sessionId("w1") });
  const drafter = sampleSession({ id: sessionId("d1"), name: "drafter", scope: { kind: "draft", id: issueId("draft-1") } });
  const answerIssue = sampleIssue({
    deliver: "answer",
    assignments: [
      {
        id: "a1",
        issue: issueId("t1"),
        agent: "lab",
        assignedAt: 1,
        executions: [
          { kind: "worker", session: older.id, startedAt: 1 },
          { kind: "worker", session: latest.id, startedAt: 2 },
        ],
      },
    ],
  });
  const draftIssue = sampleIssue({ id: issueId("draft-1"), number: 2, assignments: [], status: "backlog", stage: { state: "draft", since: 1, acts: [] } });
  const initial = withIssueStatuses({ ...emptySpaceState(), sessions: [older, latest, drafter], issues: [answerIssue, draftIssue] });

  const [afterStale] = reduce(initial, {
    type: "sessionReported",
    at: 5,
    id: older.id,
    outcome: "completed",
    summary: "old",
    runs: 1,
    questions: [],
    checks: [],
    answer,
  });
  expect(afterStale.issues.find((i) => i.id === answerIssue.id)?.answer).toBeUndefined();

  const [afterLatest] = reduce(afterStale, {
    type: "sessionReported",
    at: 6,
    id: latest.id,
    outcome: "completed",
    summary: "answered",
    runs: 1,
    questions: [],
    checks: [],
    answer,
  });
  const updatedAnswer = afterLatest.issues.find((i) => i.id === answerIssue.id);
  expect(updatedAnswer?.answer).toEqual(answer);
  expect(updatedAnswer?.status).toBe("in_review");

  for (const item of afterLatest.issues) {
    expect(item.status).toBe(issueStatusOf(item, afterLatest));
    expect(item.refining).toEqual(issueRefiningOf(item, afterLatest));
  }
});
