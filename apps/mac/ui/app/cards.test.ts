import "../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Issue, IssueId, IssueStageKind, Session, SessionId } from "@vibevalley/protocol";

import { type BoardCard, cardUrgencyTone } from "../features/issue/model/cards";

function makeIssue(id: string, state: IssueStageKind): Issue {
  return {
    id: id as IssueId,
    number: 1,
    title: id,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: state === "reviewing" ? "in_review" : state === "done" ? "done" : state === "canceled" ? "canceled" : "in_progress",
    moves: [],
    priority: "medium",
    deliver: "change",
    repo: "vibevalley",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: 1_000,
    stage: { state, acts: [] },
  };
}

const dummySession: Session = {
  id: "s1" as SessionId,
  role: "worker",
  name: "老周",
  agent: "laozhou",
  runtime: "claude",
  phase: { _tag: "resting" },
  hiredAt: 1_000,
  brief: "",
  runs: 1,
  refining: false,
};

test("cardUrgencyTone maps user-blocking stages to wheat/berry and non-blocking cards to undefined", () => {
  const issueCard = (state: IssueStageKind): BoardCard => ({
    kind: "issue",
    id: state,
    lane: state === "reviewing" ? "waiting" : "working",
    issue: makeIssue(state, state),
    sessions: [dummySession],
    tag: "working",
  });

  expect(cardUrgencyTone(issueCard("asking"))).toBe("wheat");
  expect(cardUrgencyTone(issueCard("reviewing"))).toBe("wheat");
  expect(cardUrgencyTone(issueCard("stuck"))).toBe("berry");
  expect(cardUrgencyTone(issueCard("working"))).toBeUndefined();
  expect(cardUrgencyTone(issueCard("draft"))).toBeUndefined();
  expect(cardUrgencyTone(issueCard("queued"))).toBeUndefined();
  expect(cardUrgencyTone(issueCard("done"))).toBeUndefined();
  expect(cardUrgencyTone(issueCard("canceled"))).toBeUndefined();

  expect(cardUrgencyTone({ kind: "todo", id: "t1", lane: "todo", issue: makeIssue("t1", "asking") })).toBeUndefined();
  expect(cardUrgencyTone({ kind: "orchestrator", id: "o1", lane: "working", issue: makeIssue("o1", "working") })).toBeUndefined();
  expect(cardUrgencyTone({ kind: "missing", id: "m1", lane: "working", issue: makeIssue("m1", "working"), missing: ["s1"] })).toBe("berry");
  expect(cardUrgencyTone({ kind: "family", id: "f1", lane: "waiting", issue: makeIssue("f1", "reviewing"), children: [] })).toBe("wheat");
});
