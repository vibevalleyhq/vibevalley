import { describe, expect, test } from "vite-plus/test";

import { IssueStatusValues, type Issue, type IssueHistory, type IssueStatus, type SpaceView } from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { boardRows, buildCards, historyKey, laneOf, lanes, laneStatus, moveOf, ownStatus } from "./cards";
import { isRefined, issueTag, issueTitle, stageOf } from "./issue";
import { sampleIssue, sampleSession } from "./issue.samples";
const issue = (over: Partial<Issue>): Issue =>
  ({
    id: issueId("i1"),
    number: 1,
    title: "",
    priority: "none",
    createdAt: 0,
    assignments: [],
    status: "todo",
    moves: [],
    findings: [],
    questions: [],
    description: "",
    blockedBy: [],
    criteria: [],
    checks: [],
    ...over,
  }) as Issue;

describe("lanes", () => {
  test("each lane's header status lies in that lane", () => {
    for (const lane of lanes) expect(laneOf(laneStatus[lane])).toBe(lane);
  });

  test("every status has a lane, a stage and a tag that agree on closed", () => {
    for (const status of IssueStatusValues) {
      expect(lanes).toContain(laneOf(status));
      expect(laneOf(status) === "closed").toBe(issueTag(issue({ status })) === "closed");
      expect(stageOf(status) === "finish").toBe(laneOf(status) === "waiting" || laneOf(status) === "closed");
    }
  });

  test("a card says its status only where its lane does not, and a draft in todo does not", () => {
    expect(ownStatus("todo", "todo")).toBe(false);
    expect(ownStatus("todo", "backlog")).toBe(false);
    expect(ownStatus("closed", "done")).toBe(false);
    expect(ownStatus("closed", "canceled")).toBe(true);
    expect(ownStatus("working", "todo")).toBe(true);
  });
});

describe("moves between lanes", () => {
  const all: IssueStatus[] = ["todo", "done", "canceled"];

  test("only the moves the server allows", () => {
    expect(moveOf("todo", "working", all)).toBe("start");
    expect(moveOf("working", "closed", all)).toBe("close");
    expect(moveOf("waiting", "closed", ["canceled"])).toBe("close");
    expect(moveOf("closed", "working", all)).toBe("reopen");
    expect(moveOf("todo", "working", [])).toBeUndefined();
    expect(moveOf("closed", "working", ["done"])).toBeUndefined();
  });

  test("not every pair of lanes is a move", () => {
    expect(moveOf("todo", "closed", all)).toBeUndefined();
    expect(moveOf("working", "todo", all)).toBeUndefined();
    expect(moveOf("waiting", "working", all)).toBeUndefined();
  });
});

describe("titles", () => {
  const parent = issue({ id: issueId("g1"), title: "Paging" });

  test("the first line, the id when empty, the parent's title before a child", () => {
    expect(issueTitle(issue({ title: "  Fix login\nmore words" }))).toBe("Fix login");
    expect(issueTitle(issue({ title: "  " }))).toBe("i1");
    expect(issueTitle(issue({ title: "Add a cursor", parent: issueId("g1") }), [parent])).toBe("Paging · Add a cursor");
    expect(issueTitle(issue({ title: "Add a cursor", parent: issueId("g9") }), [parent])).toBe("Add a cursor");
  });
});

test("refined: a description or criteria, not just a title", () => {
  expect(isRefined(issue({ title: "x" }))).toBe(false);
  expect(isRefined(issue({ description: "why" }))).toBe(true);
  expect(isRefined(issue({ criteria: ["passes"] }))).toBe(true);
  expect(isRefined(issue({ criteria: [] }))).toBe(false);
});

test("regression: a parent without sessions keeps its review lane and unsent children remain visible", () => {
  const parent = issue({ id: issueId("parent"), status: "in_review" });
  const child = issue({ id: issueId("child"), parent: parent.id, status: "backlog" });
  const cards = buildCards(
    [parent, child].map((issue) => ({ issue, sessions: [], missingSessions: [] })),
    undefined,
    new Set(),
  );
  expect(cards.map((card) => [card.id, card.kind, card.lane])).toEqual([
    [parent.id, "family", "waiting"],
    [child.id, "todo", "todo"],
  ]);
});

describe("rows", () => {
  const core = (over: Partial<SpaceView>): SpaceView => ({
    call: "idle",
    callReason: "",
    sessions: [],
    issues: [],
    crons: [],
    connectors: [],
    machines: [],
    ...over,
  });

  const gone = sampleSession("s1", "老周", { _tag: "done" });
  const here = sampleSession("s2", "小林", { _tag: "resting" });

  test("an issue the frame keeps is the frame's, with its sessions from the farm or the history", () => {
    const live = sampleIssue(1, "修好登录", "in_review", "medium", { sessionIds: [sessionId("s1"), sessionId("s2")] });
    const read: IssueHistory[] = [{ issue: { ...live, title: "旧标题" }, sessions: [gone], missingSessions: [] }];
    expect(boardRows(core({ issues: [live], sessions: [here] }), read, false)).toEqual([{ issue: live, sessions: [gone, here], missingSessions: [] }]);
  });

  test("the older closed issues come from the history only with 更早的, and nothing before the first frame", () => {
    const live = sampleIssue(1, "开着的", "todo", "medium");
    const old = sampleIssue(2, "早就关了", "done", "medium");
    const read: IssueHistory[] = [
      { issue: live, sessions: [], missingSessions: [] },
      { issue: old, sessions: [], missingSessions: [] },
    ];
    expect(boardRows(core({ issues: [live] }), read, false)?.map((r) => r.issue.id)).toEqual(["i1"]);
    expect(boardRows(core({ issues: [live] }), read, true)?.map((r) => r.issue.id)).toEqual(["i1", "i2"]);
    expect(boardRows(undefined, read, true)).toBeUndefined();
  });

  test("a session that left after the history was read is the one the frame last had", () => {
    const live = sampleIssue(1, "修好登录", "in_review", "medium", { sessionIds: [sessionId("s1")] });
    expect(boardRows(core({ issues: [live] }), [], false, new Map([["s1", gone]]))?.[0]?.sessions).toEqual([gone]);
  });

  test("the history is read again when an issue gets a session or one leaves the farm, not when an issue moves", () => {
    const a = sampleIssue(1, "a", "todo", "medium");
    const before = historyKey(core({ issues: [a] }));
    expect(historyKey(core({ issues: [{ ...a, status: "in_progress", title: "b" }] }))).toBe(before);
    const assigned = sampleIssue(1, "a", "todo", "medium", { sessionIds: [sessionId("s2")] });
    expect(historyKey(core({ issues: [assigned], sessions: [here] }))).not.toBe(before);
    expect(historyKey(core({ issues: [assigned] }))).not.toBe(historyKey(core({ issues: [assigned], sessions: [here] })));
  });
});
