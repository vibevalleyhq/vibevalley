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
    lane: "working",
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
  const draftLook = cardLook({ kind: "todo", id: draftIssue.id, lane: "todo", issue: draftIssue }, (id) => id, [draftIssue], 2_000);
  expect(draftLook.flags).toEqual([{ text: t("web.issue.card.draft"), tone: "faint" }]);
});

test("localizeIssueError maps raw English API-key failures to localized copy with settings href", () => {
  setLocale("zh");
  const direct = localizeIssueError("no API key is set for the model");
  expect(direct.text).toBe(t("web.issue.error.missingApiKey"));
  expect(direct.settingsHref).toBe("/settings/models");

  const milestone = localizeIssueError("失败：no DeepSeek API key is set");
  expect(milestone.text).toBe(`失败：${t("web.issue.error.missingApiKey")}`);
  expect(milestone.settingsHref).toBe("/settings/models");

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

test("cardMove allows dragging todo to closed and closed to todo (revive)", () => {
  const todoCard: BoardCard = {
    kind: "todo",
    id: "i-todo",
    lane: "todo",
    issue: { ...makeIssue("i-todo", "draft"), status: "backlog", moves: ["todo", "done", "canceled"] },
  };
  expect(cardMove(todoCard, "closed")).toBe("close");
  expect(cardMove(todoCard, "working")).toBe("start");

  const closedCard: BoardCard = {
    kind: "todo",
    id: "i-closed",
    lane: "closed",
    issue: { ...makeIssue("i-closed", "done"), status: "done", moves: ["backlog"] },
  };
  expect(cardMove(closedCard, "todo")).toBe("revive");
  expect(cardMove(closedCard, "working")).toBeUndefined();
});
