import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Issue } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import {
  blockerIssuesOf,
  childIssuesOf,
  eligibleBlockerOptions,
  eligibleParentOptions,
  formatIsoDate,
  normalizeTagList,
  parseIsoDateInput,
  parseStatusFilter,
  scopeMatches,
  statusMatches,
} from "./meta";

function issueStub(id: string, number: number, status: Issue["status"], parent?: string): Issue {
  return {
    id: issueId(id),
    number,
    title: `Issue ${number}`,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status,
    moves: [],
    priority: "medium",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: 1000,
    stage: { state: "draft", acts: [] },
    ...(parent ? { parent: issueId(parent) } : {}),
  };
}

test("eligibleParentOptions excludes self and transitive descendants to prevent cycles", () => {
  const root = issueStub("i1", 1, "backlog");
  const child = issueStub("i2", 2, "todo", "i1");
  const grandchild = issueStub("i3", 3, "in_progress", "i2");
  const sibling = issueStub("i4", 4, "backlog");
  const all = [root, child, grandchild, sibling];

  expect(eligibleParentOptions("i1", all).map((o) => o.value)).toEqual(["i4"]);
  expect(eligibleParentOptions("i2", all).map((o) => o.value)).toEqual(["i1", "i4"]);
  expect(eligibleParentOptions("i3", all).map((o) => o.value)).toEqual(["i1", "i2", "i4"]);
  expect(childIssuesOf("i1", all).map((i) => i.id)).toEqual(["i2"]);
});

test("scopeMatches separates all, active, backlog, and canceled cleanly", () => {
  expect(scopeMatches("all", { status: "backlog" })).toBe(true);
  expect(scopeMatches("all", { status: "canceled" })).toBe(true);
  expect(scopeMatches("active", { status: "backlog" })).toBe(false);
  expect(scopeMatches("active", { status: "todo" })).toBe(true);
  expect(scopeMatches("active", { status: "in_progress" })).toBe(true);
  expect(scopeMatches("active", { status: "done" })).toBe(true);
  expect(scopeMatches("active", { status: "canceled" })).toBe(false);
  expect(scopeMatches("backlog", { status: "backlog" })).toBe(true);
  expect(scopeMatches("backlog", { status: "todo" })).toBe(false);
  expect(scopeMatches("canceled", { status: "canceled" })).toBe(true);
  expect(scopeMatches("canceled", { status: "done" })).toBe(false);
});

test("date helpers format and parse ISO YYYY-MM-DD dates and normalizeTagList deduplicates", () => {
  const ms = parseIsoDateInput("2026-12-01");
  expect(ms).toBe(Date.UTC(2026, 11, 1));
  expect(formatIsoDate(ms)).toBe("2026-12-01");
  expect(parseIsoDateInput("")).toBe(0);
  expect(parseIsoDateInput("2026-02-30")).toBeUndefined();
  expect(parseIsoDateInput("not-a-date")).toBeUndefined();
  expect(normalizeTagList([" UX ", "MCP", "UX", "", "  "])).toEqual(["UX", "MCP"]);
});

test("eligibleBlockerOptions prevents self, transitive blocker cycles, and parent-child cycles", () => {
  const a = issueStub("i1", 1, "todo");
  const b: Issue = { ...issueStub("i2", 2, "todo"), blockedBy: [issueId("i1")] };
  const c: Issue = { ...issueStub("i3", 3, "in_progress"), blockedBy: [issueId("i2")] };
  const parent = issueStub("i4", 4, "backlog");
  const child = issueStub("i5", 5, "todo", "i4");
  const all = [a, b, c, parent, child];

  // i1 cannot be blocked by i1 (self), i2 (i2 -> i1), or i3 (i3 -> i2 -> i1).
  expect(eligibleBlockerOptions("i1", all).map((o) => o.value)).toEqual(["i4", "i5"]);
  // i2 cannot be blocked by i2 (self) or i3 (i3 -> i2), can be blocked by i1.
  expect(eligibleBlockerOptions("i2", all).map((o) => o.value)).toEqual(["i1", "i4", "i5"]);
  // child i5 cannot be blocked by its parent i4 (parent waits on child).
  expect(eligibleBlockerOptions("i5", all).map((o) => o.value)).toEqual(["i1", "i2", "i3"]);

  expect(blockerIssuesOf({ blockedBy: [issueId("i2"), issueId("i1"), issueId("i2"), issueId("missing")] }, all).map((i) => i.id)).toEqual(["i2", "i1"]);
});

test("parseStatusFilter and statusMatches handle single and multi-status deep-link filters", () => {
  expect(parseStatusFilter("")).toEqual([]);
  expect(parseStatusFilter("todo,in_progress,invalid,todo")).toEqual(["todo", "in_progress"]);
  expect(statusMatches("", { status: "backlog" })).toBe(true);
  expect(statusMatches("in_review", { status: "in_review" })).toBe(true);
  expect(statusMatches("in_review", { status: "todo" })).toBe(false);
  expect(statusMatches("todo,in_progress", { status: "todo" })).toBe(true);
  expect(statusMatches("todo,in_progress", { status: "in_progress" })).toBe(true);
  expect(statusMatches("todo,in_progress", { status: "in_review" })).toBe(false);
});
