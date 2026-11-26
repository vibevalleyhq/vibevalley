import "../../../infra/polyfill";
import { effect, signal } from "nsh";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { addUtcDays, DAY_MS, utcDayStart } from "../model/schedule";
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

test("IssuesPage supports Timeline (Gantt) and Calendar views with scale switching, quick date shifts, overflow toggle, and day creation", async () => {
  setLocale("zh");
  const todayMs = utcDayStart(SCENARIO_NOW); // 2026-11-20

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
    dueAt: addUtcDays(todayMs, 3),
  });
  const extraA = makeIssue({
    id: "i-extra-a",
    number: 12,
    title: "Calendar overlap A",
    startAt: todayMs,
    dueAt: addUtcDays(todayMs, 1),
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
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 30, issues: all },
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

  // 4 scheduled rows (parent epic rolled up + 3 explicitly scheduled children/items) and 1 unscheduled.
  expect(app.count("id:timeline-row")).toBe(4);
  expect(app.count("id:timeline-bar")).toBe(4);
  expect(app.count("id:timeline-today-line")).toBe(1);
  expect(app.count("id:timeline-unscheduled-toggle")).toBe(1);

  // Scale switcher cycles week / quarter / month cleanly.
  await app.press("id:timeline-scale-week");
  await app.press("id:timeline-scale-quarter");
  await app.press("id:timeline-scale-month");

  // Shift +1d inline sends issue.update with shifted startAt/dueAt.
  await app.press("id:timeline-lane-i-child-1 >> id:timeline-shift-next");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  const shiftCall = fake.calls.find((c) => c.op === "issue.update");
  expect(shiftCall?.payload).toMatchObject({
    id: "i-child-1",
    startAt: todayMs + DAY_MS,
    dueAt: addUtcDays(todayMs, 4),
  });

  // Toggle unscheduled drawer and schedule the unscheduled item to today.
  await app.press("id:timeline-unscheduled-toggle");
  await fake.pumpUntil(app, () => app.count("id:timeline-unscheduled-list") === 1);
  expect(app.count("id:timeline-unscheduled-item")).toBe(1);
  await app.press("id:timeline-schedule-today-i-unsched");
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 2);

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
  const dateUpdate = fake.calls.findLast((c) => c.op === "issue.update");
  expect(dateUpdate?.payload).toMatchObject({
    id: "i-created-cal",
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
