import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Issue } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { childIssuesOf, eligibleParentOptions, formatIsoDate, normalizeTagList, parseIsoDateInput, scopeMatches } from "./meta";

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
