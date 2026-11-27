import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { BoardSummary, Issue } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { Registry } from "../../../infra/state/atom";
import { buildCards } from "./cards";
import { boardLook, defaultLook } from "./display";
import { addUtcDays, buildMonthGrid, buildScheduleForCards, groupScheduledByDay, shiftIssueDates, shiftMonth, utcDayStart } from "./schedule";

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

function summaryForSpan(issue: Issue, startMs: number, endMs: number, todayDayMs: number): BoardSummary {
  const durationDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  const span = {
    startMs,
    endMs,
    durationDays,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  return {
    laneCounts: { backlog: 0, todo: 1, inProgress: 0, inReview: 0, done: 0, canceled: 0 },
    runningSlots: 0,
    maxRunning: 3,
    byIssue: {
      [issue.id]: {
        lane: "todo",
        cardKind: "todo",
        familyDone: 0,
        familyTotal: 0,
        needsWorktreeCheck: false,
        schedule: span,
      },
    },
    schedule: {
      todayDayMs,
      scheduled: [{ issueId: issue.id, span, depth: 0, isParent: false, childCount: 0 }],
      unscheduledIds: [],
    },
  };
}

test("buildScheduleForCards generates scale ticks and month bands across week, month, and quarter scales", () => {
  const now = Date.UTC(2026, 10, 20);
  const start = Date.UTC(2026, 10, 20);
  const end = Date.UTC(2026, 11, 10);
  const issue = issueStub({
    id: "i-1",
    number: 1,
    startAt: start,
    dueAt: end,
  });
  const summary = summaryForSpan(issue, start, end, now);
  const cards = buildCards([{ issue, sessions: [], missingSessions: [] }], { seq: 1, issues: [issue], boardSummary: summary }, undefined, new Set());

  const weekGrid = buildScheduleForCards(cards, [issue], "week", now, summary);
  expect(weekGrid.totalDays).toBeGreaterThanOrEqual(28);
  expect(weekGrid.ticks.some((t) => t.isToday)).toBe(true);
  expect(weekGrid.months.length).toBeGreaterThanOrEqual(2);

  const quarterGrid = buildScheduleForCards(cards, [issue], "quarter", now, summary);
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

  const start = Date.UTC(2026, 10, 25);
  const end = Date.UTC(2026, 10, 27);
  const spanIssue = issueStub({
    id: "i-cal",
    number: 25,
    startAt: start,
    dueAt: end,
  });
  const summary = summaryForSpan(spanIssue, start, end, now);
  const cards = buildCards(
    [{ issue: spanIssue, sessions: [], missingSessions: [] }],
    { seq: 1, issues: [spanIssue], boardSummary: summary },
    undefined,
    new Set(),
  );
  const gridSchedule = buildScheduleForCards(cards, [spanIssue], "month", now, summary);
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
  boardLook.inRegistry(reg1).set({ ...defaultLook, view: "timeline", grouping: "status", ordering: "manual" });
  expect(boardLook.inRegistry(reg1).get().view).toBe("timeline");
  boardLook.inRegistry(reg1).set({ ...defaultLook, view: "calendar", grouping: "status", ordering: "manual" });
  expect(boardLook.inRegistry(reg1).get().view).toBe("calendar");

  boardLook.inRegistry(reg1).set({ ...defaultLook, groupBy: "owner", hierarchy: "parents_only" });
  expect(boardLook.inRegistry(reg1).get().groupBy).toBe("owner");
  expect(boardLook.inRegistry(reg1).get().hierarchy).toBe("parents_only");

  localStorage.setItem(
    "vibevalley.board.look",
    JSON.stringify({ view: "unknown_view", grouping: "status", ordering: "manual", groupBy: "bad", hierarchy: "bad" }),
  );
  const reg2 = new Registry();
  expect(boardLook.inRegistry(reg2).get().view).toBe("board");
  expect(boardLook.inRegistry(reg2).get().groupBy).toBe("none");
  expect(boardLook.inRegistry(reg2).get().hierarchy).toBe("all");
});
