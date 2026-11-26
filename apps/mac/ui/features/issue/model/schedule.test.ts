import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { Issue } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { Registry } from "../../../infra/state/atom";
import { buildCards } from "./cards";
import { boardLook } from "./display";
import { addUtcDays, buildMonthGrid, buildScheduleForCards, computeSchedule, groupScheduledByDay, shiftIssueDates, shiftMonth, utcDayStart } from "./schedule";

function issueStub(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number }): Issue {
  return {
    title: `Issue ${overrides.number}`,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["in_progress", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: Date.UTC(2026, 10, 1),
    stage: { state: "draft", acts: [] },
    ...overrides,
    id: issueId(overrides.id),
  };
}

test("computeSchedule computes explicit spans, single-date spans, closedAt fallback, overdue flags, and unscheduled issues", () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0); // 2026-11-20
  const explicitSpan = issueStub({
    id: "i-span",
    number: 1,
    startAt: Date.UTC(2026, 10, 18),
    dueAt: Date.UTC(2026, 10, 22),
  });
  const overdueOpen = issueStub({
    id: "i-overdue",
    number: 2,
    status: "in_progress",
    dueAt: Date.UTC(2026, 10, 19),
  });
  const closedPastDue = issueStub({
    id: "i-closed",
    number: 3,
    status: "done",
    startAt: Date.UTC(2026, 10, 10),
    dueAt: Date.UTC(2026, 10, 15),
    closedAt: Date.UTC(2026, 10, 14),
  });
  const startAndClosed = issueStub({
    id: "i-start-closed",
    number: 4,
    status: "done",
    startAt: Date.UTC(2026, 10, 12),
    closedAt: Date.UTC(2026, 10, 16),
  });
  const unscheduled = issueStub({
    id: "i-none",
    number: 5,
    priority: "urgent",
  });

  const result = computeSchedule([explicitSpan, overdueOpen, closedPastDue, startAndClosed, unscheduled], now);
  expect(result.todayDayMs).toBe(Date.UTC(2026, 10, 20));
  expect(result.unscheduled.map((i) => i.id)).toEqual(["i-none"]);
  expect(result.scheduled.map((s) => s.issue.id)).toEqual(["i-closed", "i-start-closed", "i-span", "i-overdue"]);

  const byId = new Map<string, (typeof result.scheduled)[number]>(result.scheduled.map((s) => [s.issue.id, s]));
  expect(byId.get("i-span")?.span).toMatchObject({
    startMs: Date.UTC(2026, 10, 18),
    endMs: Date.UTC(2026, 10, 22),
    durationDays: 5,
    rolledUp: false,
    overdue: false,
  });
  expect(byId.get("i-overdue")?.span).toMatchObject({
    startMs: Date.UTC(2026, 10, 19),
    endMs: Date.UTC(2026, 10, 19),
    durationDays: 1,
    overdue: true,
  });
  expect(byId.get("i-closed")?.span.overdue).toBe(false);
  expect(byId.get("i-start-closed")?.span).toMatchObject({
    startMs: Date.UTC(2026, 10, 12),
    endMs: Date.UTC(2026, 10, 16),
    durationDays: 5,
    overdue: false,
  });
});

test("computeSchedule rolls up earliest child start and latest child due onto unscheduled parent and orders children beneath parent", () => {
  const now = Date.UTC(2026, 10, 20);
  const parent = issueStub({ id: "p-1", number: 10, title: "Epic" });
  const childA = issueStub({
    id: "c-1",
    number: 11,
    parent: issueId("p-1"),
    startAt: Date.UTC(2026, 10, 25),
    dueAt: Date.UTC(2026, 10, 28),
  });
  const childB = issueStub({
    id: "c-2",
    number: 12,
    parent: issueId("p-1"),
    startAt: Date.UTC(2026, 10, 21),
    dueAt: Date.UTC(2026, 11, 2),
  });
  const sibling = issueStub({
    id: "s-1",
    number: 13,
    startAt: Date.UTC(2026, 10, 22),
    dueAt: Date.UTC(2026, 10, 24),
  });

  const result = computeSchedule([childA, parent, sibling, childB], now);
  expect(result.unscheduled).toEqual([]);
  expect(result.scheduled.map((r) => ({ id: r.issue.id, depth: r.depth, isParent: r.isParent }))).toEqual([
    { id: "p-1", depth: 0, isParent: true },
    { id: "c-2", depth: 1, isParent: false },
    { id: "c-1", depth: 1, isParent: false },
    { id: "s-1", depth: 0, isParent: false },
  ]);
  expect(result.scheduled[0]?.span).toMatchObject({
    startMs: Date.UTC(2026, 10, 21),
    endMs: Date.UTC(2026, 11, 2),
    rolledUp: true,
    durationDays: 12,
  });
});

test("buildScheduleForCards generates scale ticks and month bands across week, month, and quarter scales", () => {
  const now = Date.UTC(2026, 10, 20);
  const issue = issueStub({
    id: "i-1",
    number: 1,
    startAt: Date.UTC(2026, 10, 20),
    dueAt: Date.UTC(2026, 11, 10),
  });
  const cards = buildCards([{ issue, sessions: [], missingSessions: [] }], undefined, undefined, new Set());

  const weekGrid = buildScheduleForCards(cards, [issue], "week", now);
  expect(weekGrid.totalDays).toBeGreaterThanOrEqual(28);
  expect(weekGrid.ticks.some((t) => t.isToday)).toBe(true);
  expect(weekGrid.months.length).toBeGreaterThanOrEqual(2);

  const quarterGrid = buildScheduleForCards(cards, [issue], "quarter", now);
  expect(quarterGrid.totalDays).toBeGreaterThanOrEqual(98);
  expect(quarterGrid.ticks[0]?.isMonday).toBe(true);
});

test("buildMonthGrid creates Mon-Sun calendar grids and groupScheduledByDay maps multi-day spans", () => {
  // November 2026 starts on Sunday (Nov 1, 2026 -> 6 leading days Mon..Sat of Oct).
  const now = Date.UTC(2026, 10, 26);
  const grid = buildMonthGrid(2026, 11, now);
  expect(grid.year).toBe(2026);
  expect(grid.month).toBe(11);
  expect(grid.weeks.length).toBe(6);
  expect(grid.cells[0]?.dateKey).toBe("2026-10-26");
  expect(grid.cells[0]?.inMonth).toBe(false);
  expect(grid.cells[6]?.dateKey).toBe("2026-11-01");
  expect(grid.cells[6]?.inMonth).toBe(true);
  expect(grid.cells.find((c) => c.dateKey === "2026-11-26")?.isToday).toBe(true);

  const next = shiftMonth(2026, 12, 1);
  expect(next).toEqual({ year: 2027, month: 1 });
  const prev = shiftMonth(2026, 1, -1);
  expect(prev).toEqual({ year: 2025, month: 12 });

  const spanIssue = issueStub({
    id: "i-cal",
    number: 25,
    startAt: Date.UTC(2026, 10, 25),
    dueAt: Date.UTC(2026, 10, 27),
  });
  const cards = buildCards([{ issue: spanIssue, sessions: [], missingSessions: [] }], undefined, undefined, new Set());
  const gridSchedule = buildScheduleForCards(cards, [spanIssue], "month", now);
  const byDay = groupScheduledByDay(grid, gridSchedule.rows);
  expect(byDay.get("2026-11-24")).toEqual([]);
  expect(byDay.get("2026-11-25")?.length).toBe(1);
  expect(byDay.get("2026-11-26")?.length).toBe(1);
  expect(byDay.get("2026-11-27")?.length).toBe(1);
  expect(byDay.get("2026-11-28")).toEqual([]);
});

test("shiftIssueDates shifts explicit dates and falls back cleanly for unscheduled/rolled-up spans", () => {
  const d1 = Date.UTC(2026, 10, 26);
  const d2 = Date.UTC(2026, 10, 29);
  expect(shiftIssueDates({ startAt: d1, dueAt: d2 }, 1)).toEqual({
    startAt: addUtcDays(d1, 1),
    dueAt: addUtcDays(d2, 1),
  });
  expect(shiftIssueDates({ dueAt: d2 }, -2)).toEqual({
    dueAt: addUtcDays(d2, -2),
  });
  expect(shiftIssueDates({}, 1, { startMs: d1, endMs: d2 })).toEqual({
    startAt: addUtcDays(utcDayStart(d1), 1),
    dueAt: addUtcDays(utcDayStart(d2), 1),
  });
});

test("boardLook preserves valid timeline/calendar views and falls back for unknown views", () => {
  const reg1 = new Registry();
  boardLook.inRegistry(reg1).set({ view: "timeline", grouping: "status", ordering: "manual" });
  expect(boardLook.inRegistry(reg1).get().view).toBe("timeline");
  boardLook.inRegistry(reg1).set({ view: "calendar", grouping: "status", ordering: "manual" });
  expect(boardLook.inRegistry(reg1).get().view).toBe("calendar");

  localStorage.setItem("vibevalley.board.look", JSON.stringify({ view: "unknown_view", grouping: "status", ordering: "manual" }));
  const reg2 = new Registry();
  expect(boardLook.inRegistry(reg2).get().view).toBe("board");
});
