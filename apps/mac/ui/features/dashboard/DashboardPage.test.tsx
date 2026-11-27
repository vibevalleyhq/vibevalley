import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import type { IssueRetroReport, RetroWindow } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function sampleRetro(window: RetroWindow): IssueRetroReport {
  if (window === "30d") {
    return {
      window: "30d",
      generatedAt: SCENARIO_NOW,
      windowStartAt: SCENARIO_NOW - 30 * DAY_MS,
      totalIssues: 0,
      openCount: 0,
      completedCount: 0,
      canceledCount: 0,
      cycleTime: { sampleCount: 0 },
      reviewWait: { sampleCount: 0 },
      withDueCount: 0,
      withoutDueCount: 0,
      onTimeCount: 0,
      overdueCount: 0,
      upcomingDueCount: 0,
      reworkIssueCount: 0,
      totalFindingsCount: 0,
      unresolvedFindingsCount: 0,
      overdueItems: [],
      reworkItems: [],
      byRepo: [],
      byTag: [],
      byAgent: [],
    };
  }
  const isAll = window === "all";
  return {
    window,
    generatedAt: SCENARIO_NOW,
    ...(isAll ? {} : { windowStartAt: SCENARIO_NOW - (window === "7d" ? 7 : 14) * DAY_MS }),
    totalIssues: isAll ? 9 : 4,
    openCount: 1,
    completedCount: isAll ? 6 : 2,
    canceledCount: isAll ? 2 : 1,
    completionRatePct: isAll ? 75 : 66.7,
    cycleTime: { sampleCount: isAll ? 6 : 2, medianMs: 4 * HOUR_MS, p90Ms: 9 * HOUR_MS },
    reviewWait: { sampleCount: isAll ? 5 : 2, medianMs: 90 * 60_000, p90Ms: 3 * HOUR_MS },
    withDueCount: 3,
    withoutDueCount: 1,
    onTimeCount: 2,
    overdueCount: 1,
    upcomingDueCount: 0,
    onTimeRatePct: 66.7,
    overdueRatePct: 33.3,
    reworkIssueCount: 1,
    totalFindingsCount: 2,
    unresolvedFindingsCount: 1,
    reworkRatePct: isAll ? 11.1 : 25,
    overdueItems: [
      {
        id: issueId("i-overdue"),
        number: 42,
        title: "Fix flaky auth redirect",
        status: "in_progress",
        repo: "vibevalley",
        agent: "laozhou",
        dueAt: SCENARIO_NOW - 2 * DAY_MS,
        overdueMs: 2 * DAY_MS,
      },
    ],
    reworkItems: [
      {
        id: issueId("i-rework"),
        number: 43,
        title: "Add retro analytics tests",
        status: "in_review",
        repo: "vibevalley",
        agent: "laozhou",
        findingsCount: 2,
        unresolvedCount: 1,
      },
    ],
    byRepo: [
      { key: "vibevalley", totalCount: 3, completedCount: 2, canceledCount: 0, overdueCount: 1, reworkCount: 1, medianCycleMs: 4 * HOUR_MS },
      { key: "", totalCount: 1, completedCount: 0, canceledCount: 1, overdueCount: 0, reworkCount: 0 },
    ],
    byTag: [{ key: "analytics", totalCount: 2, completedCount: 2, canceledCount: 0, overdueCount: 0, reworkCount: 1, medianCycleMs: 4 * HOUR_MS }],
    byAgent: [{ key: "laozhou", totalCount: 3, completedCount: 2, canceledCount: 0, overdueCount: 1, reworkCount: 1, medianCycleMs: 4 * HOUR_MS }],
  };
}

test("DashboardPage omits redundant profile hero card, hides zero pending rows, switches to hosted /dashboard/runs, and renders /runs seamlessly", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-overview") === 1);
  expect(app.count("id:dashboard-header")).toBe(1);
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:dashboard-profile-card")).toBe(0);
  expect(app.count("id:dashboard-stat-working")).toBe(1);
  expect(app.count("id:dashboard-stat-waiting")).toBe(1);
  expect(app.count("id:dashboard-pulse")).toBe(1);
  expect(app.count("id:dashboard-pending")).toBe(1);
  expect(app.count("id:dashboard-pending-waiting")).toBe(1);
  expect(app.count("id:dashboard-pending-review")).toBe(1);
  expect(app.count("id:dashboard-pending-todo")).toBe(1);
  expect(app.texts()).toContain("Waiting on your reply");
  expect(app.texts()).toContain("Issues in review");
  expect(app.texts()).toContain("Todo issues");
  expect(app.texts().some((line) => line.includes("waiting on your reply"))).toBe(false);
  expect(app.count("id:dashboard-recent-runs")).toBe(1);
  expect(app.count("id:dashboard-quick-mcp")).toBe(1);

  // When all pending items clear, zero rows collapse to the calm empty note.
  await fake.setSlice(app, "inbox", { ...scenarios.typical.state.inbox, items: [] });
  await fake.pumpUntil(app, () => app.count("id:dashboard-pending-waiting") === 0);
  await fake.setSlice(app, "board", { ...scenarios.typical.state.board, issues: [] });
  await fake.pumpUntil(app, () => app.count("id:dashboard-pending-empty") === 1);
  expect(app.count("id:dashboard-pending-review")).toBe(0);
  expect(app.count("id:dashboard-pending-todo")).toBe(0);

  await app.press("id:dashboard-tabs-runs");
  await fake.pumpUntil(app, () => app.count("id:runs-page") === 1);
  expect(app.count("id:dashboard-header")).toBe(1);
  expect(app.count("id:dashboard-overview")).toBe(0);

  await app.press("id:dashboard-tabs-overview");
  await fake.pumpUntil(app, () => app.count("id:dashboard-overview") === 1);
  expect(app.count("id:runs-page")).toBe(0);

  await app.host.send("route", "/runs");
  await fake.pumpUntil(app, () => app.count("id:runs-page") === 1);
  expect(app.count("id:dashboard-page")).toBe(1);
  expect(app.count("id:dashboard-header")).toBe(1);
});

test("DashboardPage renders Quick Navigation in a 2-column grid without narrow 4-col description truncation", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 900,
    height: 720,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-quick-mcp") === 1);
  const issuesBox = app.layout("id:dashboard-quick-issues")!;
  const chatBox = app.layout("id:dashboard-quick-chat")!;
  const farmBox = app.layout("id:dashboard-quick-farm")!;
  const mcpBox = app.layout("id:dashboard-quick-mcp")!;

  expect(issuesBox.y).toBe(chatBox.y);
  expect(farmBox.y).toBeGreaterThan(issuesBox.y);
  expect(mcpBox.y).toBe(farmBox.y);
  expect(issuesBox.width).toBeGreaterThan(300);
  expect(mcpBox.width).toBeGreaterThan(300);
});

test("DashboardPage Retro tab switches time windows, renders analytics, handles empty windows, and copies Markdown report", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  fake.respond("issue.retro.get", (payload: unknown) => {
    const window = (payload as { window?: RetroWindow } | undefined)?.window ?? "7d";
    return sampleRetro(window);
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-overview") === 1);
  await app.press("id:dashboard-tabs-retro");
  await fake.pumpUntil(app, () => app.count("id:retro-kpis") === 1 && app.count("id:retro-overdue-row-i-overdue") === 1);

  expect(app.shows("id:retro-toolbar >> text:4 issues in window")).toBe(true);
  expect(app.shows("id:retro-kpi-due >> text:66.7%")).toBe(true);
  expect(app.shows("id:retro-kpi-rework >> text:25%")).toBe(true);
  expect(app.count("id:retro-breakdown-repo")).toBe(1);
  expect(app.count("id:retro-breakdown-tag")).toBe(1);
  expect(app.count("id:retro-breakdown-agent")).toBe(1);
  expect(app.shows("id:retro-overdue-row-i-overdue >> text:#42")).toBe(true);
  expect(app.shows("id:retro-rework-row-i-rework >> text:#43")).toBe(true);

  await app.press("id:retro-copy-report");
  await app.waitUntil(() => (app.clipboard() ?? "").includes("Issue Retro Report (7d)"));
  const md = app.clipboard() ?? "";
  expect(md).toContain("Throughput: 2 done, 1 canceled, 1 open (total 4)");
  expect(md).toContain("#42 Fix flaky auth redirect");
  expect(md).toContain("#43 Add retro analytics tests");
  expect(md).toContain("## By Repository");
  expect(md).toContain("## By Tag");
  expect(md).toContain("## By Agent");

  // Switch to 14d, 30d (empty window), and all.
  await app.press("id:retro-window-14d");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.retro.get" && (c.payload as { window?: string })?.window === "14d"));

  await app.press("id:retro-window-30d");
  await fake.pumpUntil(app, () => app.count("id:retro-empty") === 1);
  expect(app.count("id:retro-overdue-table")).toBe(0);

  await app.press("id:retro-window-all");
  await fake.pumpUntil(app, () => app.shows("id:retro-toolbar >> text:9 issues in window"));
  expect(app.shows("id:retro-kpi-throughput >> text:6")).toBe(true);
  expect(app.shows("id:retro-kpi-rework >> text:11.1%")).toBe(true);

  // Direct /dashboard/retro route opens the Retro tab.
  await app.host.send("route", "/dashboard/retro");
  await fake.pumpUntil(app, () => app.count("id:dashboard-retro") === 1);
});

test("DashboardPage overview stat cards and pending rows deep-link into pre-filtered /issues views", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-stat-issues") === 1);

  // Clicking the Review stat card navigates to /issues?status=in_review and pre-filters the board.
  await app.press("id:dashboard-stat-review");
  await fake.pumpUntil(app, () => app.count("id:issues-page") === 1);
  expect(app.count("id:filter-clear")).toBe(1);
  expect(app.count("id:issue-card")).toBe(scenarios.typical.state.board.issues.filter((i) => i.status === "in_review").length);

  // Navigate back to dashboard and test Open Issues stat card -> /issues?status=todo,in_progress.
  await app.host.send("route", "/dashboard");
  await fake.pumpUntil(app, () => app.count("id:dashboard-stat-issues") === 1);
  await app.press("id:dashboard-stat-issues");
  await fake.pumpUntil(app, () => app.count("id:issues-page") === 1);
  expect(app.count("id:filter-clear")).toBe(1);
  expect(app.count("id:issue-card")).toBe(scenarios.typical.state.board.issues.filter((i) => i.status === "todo" || i.status === "in_progress").length);

  // Navigate back to dashboard and test Pending Todo row -> /issues?status=todo.
  await app.host.send("route", "/dashboard");
  await fake.pumpUntil(app, () => app.count("id:dashboard-pending-todo") === 1);
  await app.press("id:dashboard-pending-todo");
  await fake.pumpUntil(app, () => app.count("id:issues-page") === 1);
  expect(app.count("id:filter-clear")).toBe(1);
  expect(app.count("id:issue-card")).toBe(scenarios.typical.state.board.issues.filter((i) => i.status === "todo").length);
});

test("DashboardPage renders 3-part Morning Digest and applies backlog triage ONLY after explicit Confirm click", async () => {
  setLocale("en");
  const digest = {
    generatedAt: SCENARIO_NOW,
    windowStart: SCENARIO_NOW - 86_400_000,
    windowEnd: SCENARIO_NOW,
    progress: {
      asking: [{ id: issueId("i1"), number: 1, title: "Clarify OAuth scope", detail: "Use PKCE?" }],
      reviewing: [],
      stuck: [],
      working: [],
      completedRecent: [{ id: issueId("i2"), number: 2, title: "Ship health check", detail: "" }],
      runsTotal: 2,
      runsCompleted: 1,
      runsFailed: 1,
      runsInterrupted: 0,
      tokensSpent: 500,
    },
    repoHealth: [
      {
        repo: "alpha",
        status: "at_risk",
        reasons: ["asking_user"],
        openIssues: 2,
        inProgressIssues: 1,
        inReviewIssues: 0,
        blockedIssues: 0,
        stuckIssues: 0,
        askingIssues: 1,
        failedChecks: 0,
        overdueIssues: 0,
        evaluatedAt: SCENARIO_NOW,
      },
      {
        repo: "beta",
        status: "on_track",
        reasons: ["healthy"],
        openIssues: 0,
        inProgressIssues: 0,
        inReviewIssues: 0,
        blockedIssues: 0,
        stuckIssues: 0,
        askingIssues: 0,
        failedChecks: 0,
        overdueIssues: 0,
        evaluatedAt: SCENARIO_NOW,
      },
    ],
    triage: [
      {
        id: "auto:i1:priority",
        issueId: issueId("i1"),
        issueNumber: 1,
        issueTitle: "Clarify OAuth scope",
        reason: "Due within 48 hours",
        summary: "Raise #1 priority to High",
        source: "system",
        patch: { priority: "high" },
        createdAt: SCENARIO_NOW,
      },
    ],
  };

  let pendingTriage = [...digest.triage];
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  fake.respond("issue.digest.get", () => ({ ...digest, triage: pendingTriage }));
  fake.respond("issue.triage.confirm", (payload: unknown) => {
    const req = payload as { id: string };
    pendingTriage = pendingTriage.filter((s) => s.id !== req.id);
    return { ...scenarios.typical.state.board.issues[0], id: issueId("i1"), priority: "high", seq: scenarios.typical.state.seq + 1 };
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-morning-digest") === 1 && app.count("id:triage-confirm-auto:i1:priority") === 1);
  expect(app.count("id:digest-part-progress")).toBe(1);
  expect(app.count("id:digest-part-health")).toBe(1);
  expect(app.count("id:digest-part-triage")).toBe(1);
  expect(app.shows("id:digest-part-health >> text:Waiting for user response")).toBe(true);
  expect(app.shows("id:digest-part-health >> text:On track")).toBe(true);
  expect(app.texts().some((line) => line.includes("Healthy and moving smoothly"))).toBe(false);

  // Confirm is NEVER auto-invoked on render.
  expect(fake.calls.some((c) => c.op === "issue.triage.confirm")).toBe(false);

  // Clicking Confirm & Apply dispatches issue.triage.confirm for that suggestion.
  await app.press("id:triage-confirm-auto:i1:priority");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.triage.confirm"));
  expect(fake.calls.find((c) => c.op === "issue.triage.confirm")?.payload).toEqual({ id: "auto:i1:priority" });
  await fake.pumpUntil(app, () => app.count("id:triage-confirm-auto:i1:priority") === 0);
});
