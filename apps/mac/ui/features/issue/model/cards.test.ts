import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, IssueStageKind, Session, SessionId } from "@vibevalley/protocol";

import { type BoardCard, cardLook, cardMove, cardUrgencyTone, historyKey } from "./cards";
import { localizeIssueError } from "./issueError";
import { issueState } from "./overview";

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
  controller: "issueBoard",
  role: "worker",
  name: "老周",
  profile: "laozhou",
  runtime: "claude",
  policy: { kind: "sandboxDir" },
  bindings: [],
  phase: { _tag: "resting" },
  hiredAt: 1_000,
  brief: "",
  runs: 1,
};

test("cardUrgencyTone maps user-blocking stages to wheat/berry and non-blocking cards to undefined", () => {
  const issueCard = (state: IssueStageKind): BoardCard => ({
    kind: "issue",
    id: state,
    lane: state === "reviewing" ? "in_review" : "in_progress",
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
  expect(cardUrgencyTone({ kind: "orchestrator", id: "o1", lane: "in_progress", issue: makeIssue("o1", "working") })).toBeUndefined();
  expect(cardUrgencyTone({ kind: "missing", id: "m1", lane: "in_progress", issue: makeIssue("m1", "working"), missing: ["s1"] })).toBe("berry");
  expect(cardUrgencyTone({ kind: "family", id: "f1", lane: "in_review", issue: makeIssue("f1", "reviewing"), children: [] })).toBe("wheat");
});

test("cardLook and issueState preserve full titles over 40 chars and quiet draft flags", () => {
  setLocale("zh");
  const longTitle = "Polish mobile responsive layout for remote worktree session view";
  const activeIssue: Issue = {
    ...makeIssue("i-long", "working"),
    title: longTitle,
  };
  const card: BoardCard = {
    kind: "issue",
    id: activeIssue.id,
    lane: "in_progress",
    issue: activeIssue,
    sessions: [dummySession],
    tag: "working",
  };
  expect(cardLook(card, (id) => id, [activeIssue], 2_000).title).toBe(longTitle);
  expect(issueState(activeIssue, [dummySession], undefined, [activeIssue]).title).toBe(longTitle);

  const draftIssue: Issue = {
    ...makeIssue("i-draft", "draft"),
    status: "backlog",
  };
  const draftLook = cardLook({ kind: "todo", id: draftIssue.id, lane: "backlog", issue: draftIssue }, (id) => id, [draftIssue], 2_000);
  expect(draftLook.flags).toEqual([]);

  const queuedIssue: Issue = {
    ...makeIssue("i-queued", "queued"),
    status: "todo",
    queuedAt: 1_500,
  };
  const queuedLook = cardLook({ kind: "todo", id: queuedIssue.id, lane: "todo", issue: queuedIssue }, (id) => id, [queuedIssue], 2_000);
  expect(queuedLook.flags).toEqual([{ text: t("web.issue.card.queued"), tone: "water" }]);

  const nonSessionReview: Issue = {
    ...makeIssue("i-review-todo", "draft"),
    status: "in_review",
  };
  const reviewTodoLook = cardLook({ kind: "todo", id: nonSessionReview.id, lane: "in_review", issue: nonSessionReview }, (id) => id, [nonSessionReview], 2_000);
  expect(reviewTodoLook.flags).toEqual([]);
});

test("localizeIssueError maps raw English API-key failures to localized copy with settings href", () => {
  setLocale("zh");
  const direct = localizeIssueError("no API key is set for the model");
  expect(direct.text).toBe(t("web.issue.error.missingApiKey"));
  expect(direct.settingsHref).toBe("/settings/providers");

  const milestone = localizeIssueError("失败：no DeepSeek API key is set");
  expect(milestone.text).toBe(`失败：${t("web.issue.error.missingApiKey")}`);
  expect(milestone.settingsHref).toBe("/settings/providers");

  const unrelated = localizeIssueError("exit status 1");
  expect(unrelated).toEqual({ text: "exit status 1" });
});

test("historyKey tracks board seq and non-session issue status changes", () => {
  const backlogIssue: Issue = { ...makeIssue("i-draft", "draft"), status: "backlog" };
  const doneIssue: Issue = { ...backlogIssue, status: "done" };
  const k1 = historyKey({ seq: 1, issues: [backlogIssue] }, []);
  const k2 = historyKey({ seq: 2, issues: [backlogIssue] }, []);
  const k3 = historyKey({ seq: 2, issues: [doneIssue] }, []);
  expect(k1).not.toBe(k2);
  expect(k2).not.toBe(k3);
  expect(historyKey(undefined, [])).toBe("");
});

test("cardMove allows dragging across all 6 status lanes while keeping backlog->todo dispatch as start", () => {
  const backlogCard: BoardCard = {
    kind: "todo",
    id: "i-todo",
    lane: "backlog",
    issue: { ...makeIssue("i-todo", "draft"), status: "backlog", moves: ["todo", "in_progress", "in_review", "done", "canceled"] },
  };
  expect(cardMove(backlogCard, "done")).toBe("close");
  expect(cardMove(backlogCard, "canceled")).toBe("close");
  expect(cardMove(backlogCard, "todo")).toBe("start");
  expect(cardMove(backlogCard, "in_progress")).toBe("track");
  expect(cardMove(backlogCard, "in_review")).toBe("track");

  const doneCard: BoardCard = {
    kind: "todo",
    id: "i-closed",
    lane: "done",
    issue: { ...makeIssue("i-closed", "done"), status: "done", moves: ["backlog", "todo", "in_progress", "in_review", "canceled"] },
  };
  expect(cardMove(doneCard, "backlog")).toBe("revive");
  expect(cardMove(doneCard, "in_progress")).toBe("track");
  expect(cardMove(doneCard, "in_review")).toBe("track");
});
