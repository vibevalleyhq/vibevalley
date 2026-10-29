import { describe, expect, test } from "vite-plus/test";
import { IssueStatusValues, type Issue, type IssueStatus, type TaskGraph } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";
import { isRefined, issueInTask, issueTag, issueTitle, laneOf, lanes, laneStatus, moveOf, ownStatus, stageOf } from "./rules";

const issue = (over: Partial<Issue>): Issue =>
  ({
    id: issueId("i1"),
    number: 1,
    title: "",
    priority: "none",
    createdAt: 0,
    sessions: [],
    status: "todo",
    moves: [],
    findings: [],
    questions: [],
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
  const graph = { id: "g1", title: "Paging" } as TaskGraph;

  test("the first line, the id when empty, the graph's title before a step", () => {
    expect(issueTitle(issue({ title: "  Fix login\nmore words" }))).toBe("Fix login");
    expect(issueTitle(issue({ title: "  " }))).toBe("i1");
    expect(issueTitle(issue({ title: "Add a cursor", parent: issueId("g1") }), [graph])).toBe("Paging · Add a cursor");
    expect(issueTitle(issue({ title: "Add a cursor", parent: issueId("g9") }), [graph])).toBe("Add a cursor");
  });
});

test("refined: a description or criteria, not just a title", () => {
  expect(isRefined(issue({ title: "x" }))).toBe(false);
  expect(isRefined(issue({ description: "why" }))).toBe(true);
  expect(isRefined(issue({ criteria: ["passes"] }))).toBe(true);
  expect(isRefined(issue({ criteria: [] }))).toBe(false);
});

test("in a task: by its graph, its parent, its session's graph, or a merge into its parent", () => {
  expect(issueInTask(issue({}), undefined)).toBe(false);
  expect(issueInTask(issue({ parent: issueId("g1") }), undefined)).toBe(true);
  expect(issueInTask(issue({ delivered: "merged_into_parent" }), undefined)).toBe(true);
});
