import "../../../infra/polyfill";
import { effect, signal } from "nsh";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { addUtcDays, computeTimelineDrag, DAY_MS, timelineScaleSpec, utcDayStart } from "../model/schedule";
import { createFrameQueue } from "./IssueTimeline";

function makeIssue(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number; title: string }): Issue {
  return {
    description: "Scheduled issue fixture",
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
    createdAt: SCENARIO_NOW - 86_400_000,
    stage: { state: "draft", acts: [] },
    ...overrides,
    id: overrides.id as IssueId,
  };
}

test("computeTimelineDrag snaps move and edge resizes while clamping startAt <= dueAt", () => {
  const d1 = Date.UTC(2026, 10, 20);
  const d2 = Date.UTC(2026, 10, 23);
  const span = { startMs: d1, endMs: d2 };

  const moved = computeTimelineDrag({ startAt: d1, dueAt: d2 }, span, "move", 2);
  expect(moved.startMs).toBe(addUtcDays(d1, 2));
  expect(moved.endMs).toBe(addUtcDays(d2, 2));
  expect(moved.durationDays).toBe(4);
  expect(moved.dates).toEqual({ startAt: addUtcDays(d1, 2), dueAt: addUtcDays(d2, 2) });

  // Left handle clamped so startAt never exceeds dueAt.
  const clampedStart = computeTimelineDrag({ startAt: d1, dueAt: d2 }, span, "resize-start", 10);
  expect(clampedStart.startMs).toBe(d2);
  expect(clampedStart.endMs).toBe(d2);
  expect(clampedStart.durationDays).toBe(1);
  expect(clampedStart.dates).toEqual({ startAt: d2, dueAt: d2 });

  // Right handle clamped so dueAt never precedes startAt.
  const clampedEnd = computeTimelineDrag({ startAt: d1, dueAt: d2 }, span, "resize-end", -10);
  expect(clampedEnd.startMs).toBe(d1);
  expect(clampedEnd.endMs).toBe(d1);
  expect(clampedEnd.durationDays).toBe(1);
  expect(clampedEnd.dates).toEqual({ startAt: d1, dueAt: d1 });

  // Due-only issue extended rightward preserves startMs as startAt.
  const dueOnlyExtended = computeTimelineDrag({ dueAt: d1 }, { startMs: d1, endMs: d1 }, "resize-end", 2);
  expect(dueOnlyExtended.dates).toEqual({ startAt: d1, dueAt: addUtcDays(d1, 2) });
});

test("IssuesPage supports Timeline (Gantt) direct drag/resize, short-bar #N labels, sticky month header, and Calendar views", async () => {
  setLocale("zh");
  const todayMs = utcDayStart(SCENARIO_NOW); // 2026-11-20
  const monthDayW = timelineScaleSpec.month.dayWidth; // 28

  const epicParent = makeIssue({
    id: "i-epic",
    number: 10,
    title: "Parent epic rolled up from children",
    status: "in_progress",
    priority: "high",
  });
  const childScheduled = makeIssue({
    id: "i-child-1",
    number: 11,
    title: "Child scheduled span",
    parent: epicParent.id,
    status: "in_progress",
    priority: "urgent",
    startAt: todayMs,
    dueAt: addUtcDays(todayMs, 3), // 4 days -> 108px (>= 92 -> #11 + title)
  });
  const extraA = makeIssue({
    id: "i-extra-a",
    number: 12,
    title: "Calendar overlap A",
    startAt: todayMs,
    dueAt: addUtcDays(todayMs, 1), // 2 days -> 52px (>= 36 && < 92 -> compact #12)
  });
  const extraB = makeIssue({
    id: "i-extra-b",
    number: 13,
    title: "Calendar overlap B",
    startAt: todayMs,
    dueAt: addUtcDays(todayMs, 2),
  });
  const unscheduled = makeIssue({
    id: "i-unsched",
    number: 14,
    title: "Unscheduled backlog item",
    status: "backlog",
  });

  const all = [epicParent, childScheduled, extraA, extraB, unscheduled];
  const epicSpan = {
    startMs: todayMs,
    endMs: addUtcDays(todayMs, 3),
    durationDays: 4,
    hasExplicitStart: false,
    hasExplicitDue: false,
    rolledUp: true,
    overdue: false,
  };
  const childSpan = {
    startMs: todayMs,
    endMs: addUtcDays(todayMs, 3),
    durationDays: 4,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const extraASpan = {
    startMs: todayMs,
    endMs: addUtcDays(todayMs, 1),
    durationDays: 2,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const extraBSpan = {
    startMs: todayMs,
    endMs: addUtcDays(todayMs, 2),
    durationDays: 3,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: {
      seq: 30,
      issues: all,
      boardSummary: {
        laneCounts: { backlog: 1, todo: 2, inProgress: 2, inReview: 0, done: 0, canceled: 0 },
        runningSlots: 0,
        maxRunning: 3,
        byIssue: {
          [epicParent.id]: { lane: "in_progress", cardKind: "family", familyDone: 0, familyTotal: 1, needsWorktreeCheck: false, schedule: epicSpan },
          [childScheduled.id]: { lane: "in_progress", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: childSpan },
          [extraA.id]: { lane: "todo", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: extraASpan },
          [extraB.id]: { lane: "todo", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: extraBSpan },
          [unscheduled.id]: { lane: "backlog", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false },
        },
        schedule: {
          todayDayMs: todayMs,
          scheduled: [
            { issueId: epicParent.id, span: epicSpan, depth: 0, isParent: true, childCount: 1 },
            { issueId: childScheduled.id, span: childSpan, depth: 1, isParent: false, childCount: 0 },
            { issueId: extraA.id, span: extraASpan, depth: 0, isParent: false, childCount: 0 },
            { issueId: extraB.id, span: extraBSpan, depth: 0, isParent: false, childCount: 0 },
          ],
          unscheduledIds: [unscheduled.id],
        },
      },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond(
    "issue.history.list",
    all.map((issue) => ({ issue, sessions: [], missingSessions: [] })),
  );
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { id: string; startAt?: number; dueAt?: number };
    const found = all.find((i) => i.id === p.id) ?? childScheduled;
    return { ...found, startAt: p.startAt ?? found.startAt, dueAt: p.dueAt ?? found.dueAt, seq: 31 };
  });
  fake.respond("issue.create", (payload: unknown) => {
    const p = payload as { title?: string; startAt?: number; dueAt?: number };
    return {
      ...makeIssue({
        id: "i-created-cal",
        number: 99,
        title: p.title ?? "Calendar created",
        status: "backlog",
        ...(p.startAt !== undefined ? { startAt: p.startAt } : {}),
        ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}),
      }),
    };
  });
  fake.respond("issue.refine", (payload: unknown) => {
    const p = payload as { id: string; text?: string };
    return makeIssue({ id: p.id, number: 99, title: p.text ?? "Calendar created", status: "backlog" });
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-view-timeline") === 1 && app.count("id:issue-view-calendar") === 1);
  expect(app.count("id:issue-refresh")).toBe(1);

  // Switch to Gantt / Timeline view.
  await app.press("id:issue-view-timeline");
  await fake.pumpUntil(app, () => app.count("id:issue-timeline") === 1);

  // 4 scheduled rows, no floating 3-button pill beside bars, sticky month label visible after scrollToToday().
  expect(app.count("id:timeline-row")).toBe(4);
  expect(app.count("id:timeline-bar")).toBe(4);
  expect(app.count("id:timeline-today-line")).toBe(1);
  expect(app.count("id:timeline-unscheduled-toggle")).toBe(1);
  expect(app.count("id:timeline-shift-prev")).toBe(0);
  expect(app.count("id:timeline-shift-next")).toBe(0);
  expect(app.count("id:timeline-edit-dates")).toBe(0);
  expect(app.texts()).toContain("2026 年 11 月");

  // Short bar (2 days = 52px >= 36px && < 92px) renders compact #12 instead of blank pill.
  expect(app.count("id:timeline-lane-i-extra-a >> id:timeline-bar >> text:#12")).toBe(1);
  expect(app.count("id:timeline-lane-i-extra-a >> id:timeline-bar >> text:Calendar overlap A")).toBe(0);

  // Scale switcher cycles week / quarter / month cleanly and keeps month header visible.
  await app.press("id:timeline-scale-week");
  expect(app.texts()).toContain("2026 年 11 月");
  await app.scroll("id:timeline-grid-scroll", 220);
  const novHeader = app.layout("id:timeline-month-label >> nth=0");
  const gridScroll = app.layout("id:timeline-grid-scroll");
  expect(novHeader?.clipped).toBe(false);
  expect(novHeader && gridScroll ? novHeader.x >= gridScroll.x : false).toBe(true);
  await app.press("id:timeline-scale-quarter");
  await app.press("id:timeline-scale-month");
  await app.press("id:timeline-today");
  expect(app.texts()).toContain("2026 年 11 月");

  // Micro-drag (< 4px) on bar does not commit an update and preserves click -> onOpen.
  await app.drag("id:timeline-lane-i-child-1 >> id:timeline-bar", { x: 2, y: 0 });
  expect(fake.calls.filter((c) => c.op === "issue.update")).toHaveLength(0);
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // Dragging bar body by +1 day shows live preview pill mid-drag and commits once on release.
  await app.dragAndHold("id:timeline-lane-i-child-1 >> id:timeline-bar", { x: monthDayW, y: 0 });
  await fake.pumpUntil(app, () => app.count("id:timeline-drag-pill") === 1);
  expect(app.shows("id:timeline-drag-pill >> text:2026-11-21 -> 2026-11-24")).toBe(true);
  expect(fake.calls.filter((c) => c.op === "issue.update")).toHaveLength(0);
  await app.drop();
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  const bodyDragCall = fake.calls.find((c) => c.op === "issue.update");
  expect(bodyDragCall?.payload).toMatchObject({
    id: "i-child-1",
    startAt: todayMs + DAY_MS,
    dueAt: addUtcDays(todayMs, 4),
  });
  expect(app.count("id:timeline-drag-pill")).toBe(0);
  expect(app.count("id:issue-peek-modal")).toBe(0);

  // Dragging right edge handle extends dueAt by +2 days independently (from Nov 21..Nov 24 -> Nov 21..Nov 26).
  await app.drag("id:timeline-lane-i-child-1 >> id:timeline-resize-end", { x: monthDayW * 2, y: 0 });
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 2);
  const resizeEndCall = fake.calls.filter((c) => c.op === "issue.update").at(1);
  expect(resizeEndCall?.payload).toMatchObject({
    id: "i-child-1",
    startAt: todayMs + DAY_MS,
    dueAt: addUtcDays(todayMs, 6),
  });

  // Dragging left edge handle rightward clamps startAt <= dueAt (clamped to Nov 26..Nov 26).
  await app.drag("id:timeline-lane-i-child-1 >> id:timeline-resize-start", { x: monthDayW * 10, y: 0 });
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 3);
  const resizeStartCall = fake.calls.filter((c) => c.op === "issue.update").at(2);
  expect(resizeStartCall?.payload).toMatchObject({
    id: "i-child-1",
    startAt: addUtcDays(todayMs, 6),
    dueAt: addUtcDays(todayMs, 6),
  });

  // Dragging left edge handle leftward extends startAt back to Nov 21 independently.
  await app.drag("id:timeline-lane-i-child-1 >> id:timeline-resize-start", { x: -monthDayW * 5, y: 0 });
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 4);
  const resizeLeftCall = fake.calls.filter((c) => c.op === "issue.update").at(3);
  expect(resizeLeftCall?.payload).toMatchObject({
    id: "i-child-1",
    startAt: todayMs + DAY_MS,
    dueAt: addUtcDays(todayMs, 6),
  });

  // Toggle unscheduled drawer and schedule the unscheduled item to today.
  await app.press("id:timeline-unscheduled-toggle");
  await fake.pumpUntil(app, () => app.count("id:timeline-unscheduled-list") === 1);
  expect(app.count("id:timeline-unscheduled-item")).toBe(1);
  await app.press("id:timeline-schedule-today-i-unsched");
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 5);

  // Clicking a Gantt bar opens Quick-Peek modal.
  await app.press("id:timeline-lane-i-child-1 >> id:timeline-bar");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // Switch to Calendar view.
  await app.press("id:issue-view-calendar");
  await fake.pumpUntil(app, () => app.count("id:issue-calendar") === 1);
  expect(app.texts()).toContain("2026 年 11 月");
  expect(app.count("id:calendar-today-badge")).toBe(1);

  // Nov 21 (today + 1d) has 5 active scheduled rows (> 3), so overflow toggle renders and expands on press.
  expect(app.count("id:calendar-day-2026-11-21 >> id:calendar-pill")).toBe(3);
  expect(app.count("id:calendar-day-2026-11-21 >> id:calendar-day-more")).toBe(1);
  await app.press("id:calendar-day-2026-11-21 >> id:calendar-day-more");
  await fake.pumpUntil(app, () => app.count("id:calendar-day-2026-11-21 >> id:calendar-pill") === 5);

  // Month navigation next -> 2026 年 12 月, today -> 2026 年 11 月.
  await app.press("id:calendar-next");
  await fake.pumpUntil(app, () => app.texts().includes("2026 年 12 月"));
  await app.press("id:calendar-today");
  await fake.pumpUntil(app, () => app.texts().includes("2026 年 11 月"));

  // Clicking a calendar pill opens Quick-Peek modal.
  await app.press("id:calendar-day-2026-11-20 >> id:calendar-pill >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // Clicking + on a day cell opens NewIssue pre-scoped with that date and saves startAt/dueAt.
  await app.press("id:calendar-day-2026-11-26 >> id:calendar-day-add");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  expect(app.count("id:issue-new-dates")).toBe(1);
  await app.type("id:issue-new-text", "Calendar scheduled issue");
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  const dateCreate = fake.calls.findLast((c) => c.op === "issue.create");
  expect(dateCreate?.payload).toMatchObject({
    title: "Calendar scheduled issue",
    startAt: Date.UTC(2026, 10, 26),
    dueAt: Date.UTC(2026, 10, 26),
  });
});

test("IssueTimeline frame queue cancels pending requestAnimationFrame callbacks on cleanup and rapid view switch", async () => {
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  const queued = new Map<number, (time: number) => void>();
  const canceled: number[] = [];
  let ran = 0;
  let nextId = 100;

  globalThis.requestAnimationFrame = (cb: (time: number) => void) => {
    const id = ++nextId;
    queued.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number | undefined) => {
    if (id === undefined) return;
    canceled.push(id);
    queued.delete(id);
  };

  try {
    const mounted = signal(true);
    effect(() => {
      if (!mounted()) return;
      const frames = createFrameQueue();
      frames.schedule(() => {
        ran += 1;
      });
      frames.schedule(() => {
        ran += 1;
      });
    });

    expect(queued.size).toBe(2);
    const pendingIds = [...queued.keys()];

    mounted.set(false);

    expect(canceled).toEqual(pendingIds);
    expect(queued.size).toBe(0);
    expect(ran).toBe(0);
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  }

  // Also verify rapid scale switch -> immediate Calendar unmount completes cleanly in-app.
  setLocale("zh");
  const todayMs = utcDayStart(SCENARIO_NOW);
  const scheduled = makeIssue({
    id: "i-raf-1",
    number: 21,
    title: "Pending rAF cleanup check",
    status: "in_progress",
    startAt: todayMs,
    dueAt: addUtcDays(todayMs, 2),
  });
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 1, issues: [scheduled] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.history.list", [{ issue: scheduled, sessions: [], missingSessions: [] }]);

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-view-timeline") === 1);
  await app.press("id:issue-view-timeline");
  await fake.pumpUntil(app, () => app.count("id:issue-timeline") === 1);
  await app.press("id:timeline-scale-week");
  await app.press("id:issue-view-calendar");
  await fake.pumpUntil(app, () => app.count("id:issue-calendar") === 1);
});

test("regression: IssueCalendar keeps all 6 week rows completely accessible without week 6 clipping at 900x720 and 1280x800", async () => {
  setLocale("zh");
  const todayMs = utcDayStart(SCENARIO_NOW); // 2026-11-20 (Nov 2026 spans 6 week rows: Oct 26 - Dec 6)
  const scheduled = Array.from({ length: 8 }, (_, idx) =>
    makeIssue({
      id: `i-cal-density-${idx + 1}`,
      number: 50 + idx,
      title: `Calendar density item ${idx + 1}`,
      status: "in_progress",
      startAt: todayMs,
      dueAt: addUtcDays(todayMs, 1),
    }),
  );
  const week6Issue = makeIssue({
    id: "i-cal-week6",
    number: 60,
    title: "Week 6 milestone",
    status: "todo",
    startAt: Date.UTC(2026, 11, 6),
    dueAt: Date.UTC(2026, 11, 6),
  });
  const all = [...scheduled, week6Issue];
  const week6Day = Date.UTC(2026, 11, 6);
  const densitySpan = {
    startMs: todayMs,
    endMs: addUtcDays(todayMs, 1),
    durationDays: 2,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const week6Span = {
    startMs: week6Day,
    endMs: week6Day,
    durationDays: 1,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: {
      seq: 40,
      issues: all,
      boardSummary: {
        laneCounts: { backlog: 0, todo: 1, inProgress: 8, inReview: 0, done: 0, canceled: 0 },
        runningSlots: 0,
        maxRunning: 3,
        byIssue: Object.fromEntries([
          ...scheduled.map((issue) => [
            issue.id,
            { lane: "in_progress" as const, cardKind: "todo" as const, familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: densitySpan },
          ]),
          [week6Issue.id, { lane: "todo" as const, cardKind: "todo" as const, familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: week6Span }],
        ]),
        schedule: {
          todayDayMs: todayMs,
          scheduled: [
            ...scheduled.map((issue) => ({ issueId: issue.id, span: densitySpan, depth: 0, isParent: false, childCount: 0 })),
            { issueId: week6Issue.id, span: week6Span, depth: 0, isParent: false, childCount: 0 },
          ],
          unscheduledIds: [],
        },
      },
    },
  };

  for (const vp of [
    { width: 900, height: 720 },
    { width: 1280, height: 800 },
  ]) {
    const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
    fake.respond(
      "issue.history.list",
      all.map((issue) => ({ issue, sessions: [], missingSessions: [] })),
    );
    const app = await open("../../../app/main.tsx", {
      width: vp.width,
      height: vp.height,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count("id:issue-view-calendar") === 1);
    await app.press("id:issue-view-calendar");
    await fake.pumpUntil(app, () => app.count("id:issue-calendar") === 1);

    for (let weekIdx = 0; weekIdx < 6; weekIdx++) {
      expect(app.count(`id:calendar-week-${weekIdx}`)).toBe(1);
    }

    const scrollBox = app.layout("id:calendar-grid-scroll");
    const week6 = app.layout("id:calendar-week-5");
    const dec6 = app.layout("id:calendar-day-2026-12-06");
    expect(scrollBox).not.toBeNull();
    expect(week6).not.toBeNull();
    expect(dec6).not.toBeNull();
    expect(week6!.clipped).toBe(false);
    expect(dec6!.clipped).toBe(false);
    expect(week6!.y + week6!.height).toBeLessThanOrEqual(vp.height);
    expect(dec6!.y + dec6!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height + 1);

    // Expanding a busy day cell grows the week row, and scrolling calendar-grid-scroll reaches week 6 cleanly.
    await app.press("id:calendar-day-2026-11-20 >> id:calendar-day-more");
    await fake.pumpUntil(app, () => app.count("id:calendar-day-2026-11-20 >> id:calendar-pill") === 8);
    await app.scroll("id:calendar-grid-scroll", 400);
    const week6AfterExpand = app.layout("id:calendar-week-5");
    const dec6AfterExpand = app.layout("id:calendar-day-2026-12-06");
    expect(week6AfterExpand).not.toBeNull();
    expect(dec6AfterExpand).not.toBeNull();
    expect(week6AfterExpand!.clipped).toBe(false);
    expect(dec6AfterExpand!.clipped).toBe(false);
  }
});
