import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import "@vibevalley/i18n/catalogs";
import type { Issue, Priority } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import type { BoardCard } from "./cards";
import { defaultLook, hierarchyShows } from "./display";
import { orderedVisibleCardIds, selectRange, stepFocusId, toggleSelection } from "./triage";

function makeCard(id: string, number: number, status: Issue["status"], priority: Priority, parent?: string): BoardCard {
  const issue: Issue = {
    id: issueId(id),
    number,
    title: `Issue ${number}`,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status,
    moves: [],
    priority,
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: number * 1000,
    stage: { state: "draft", acts: [] },
    ...(parent ? { parent: issueId(parent) } : {}),
  };
  return { kind: "todo", id: issue.id, lane: status, issue };
}

test("orderedVisibleCardIds respects Board lanes, GroupBy, HierarchyMode, and stepFocusId/selectRange", () => {
  const p1 = makeCard("i1", 1, "todo", "high");
  const c1 = makeCard("i2", 2, "backlog", "urgent", "i1");
  const solo = makeCard("i3", 3, "in_progress", "low");
  const cards = [p1, c1, solo];
  const allIssues = cards.map((c) => c.issue);

  // Default board view orders by lane: backlog (i2), todo (i1), in_progress (i3).
  expect(orderedVisibleCardIds(cards, defaultLook, allIssues, false)).toEqual(["i2", "i1", "i3"]);

  // GroupBy priority orders urgent (i2), high (i1), low (i3).
  expect(orderedVisibleCardIds(cards, { ...defaultLook, view: "list", groupBy: "priority" }, allIssues, false)).toEqual(["i2", "i1", "i3"]);

  // Hierarchy top_level hides child i2 so ordered ids and focus stepping only traverse visible top-level cards.
  const topLevel = cards.filter((c) => hierarchyShows("top_level", c, allIssues));
  const topIds = orderedVisibleCardIds(topLevel, defaultLook, allIssues, false);
  expect(topIds).toEqual(["i1", "i3"]);

  expect(stepFocusId(topIds, undefined, 1)).toBe("i1");
  expect(stepFocusId(topIds, "i1", 1)).toBe("i3");
  expect(stepFocusId(topIds, "i3", 1)).toBe("i3");
  expect(stepFocusId(topIds, "i3", -1)).toBe("i1");
  expect(stepFocusId(topIds, undefined, -1)).toBe("i3");

  const toggled = toggleSelection(new Set<string>(), "i1");
  expect([...toggled]).toEqual(["i1"]);
  expect([...toggleSelection(toggled, "i1")]).toEqual([]);

  const ranged = selectRange(new Set<string>(), ["i2", "i1", "i3"], "i3", "i2");
  expect([...ranged]).toEqual(["i2", "i1", "i3"]);
});
