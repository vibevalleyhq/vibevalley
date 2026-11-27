import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

function makeIssue(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number; title: string }): Issue {
  return {
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["backlog", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 600_000,
    stage: { state: "draft", acts: [] },
    ...overrides,
    id: overrides.id as IssueId,
  };
}

function buildResponsiveState(): SliceBundle {
  const parent = makeIssue({
    id: "i-parent-long",
    number: 10,
    title: "Extremely long parent initiative title for layout verification",
    status: "in_progress",
    repo: "vibevalley",
  });
  const child = makeIssue({
    id: "i-child-tags",
    number: 42,
    title: "Fix responsive row alignment with long title and parent badge",
    parent: parent.id,
    status: "todo",
    repo: "vibevalley",
    tags: ["arch", "storage", "voice"],
  });
  return {
    ...scenarios.empty.state,
    board: { seq: 20, issues: [parent, child] },
  };
}

async function mountIssuesAt(width: number, height: number, locale: "en" | "zh") {
  setLocale(locale);
  const state = buildResponsiveState();
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale });
  fake.respond("issue.history.list", () => state.board.issues.map((issue) => ({ issue, sessions: [], missingSessions: [] })));

  const app = await open("../../../app/main.tsx", {
    width,
    height,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issues-toolbar") === 1);
  return { app, fake };
}

test("IssuesPage collapses secondary filters into a filter popover below 1100px so h-11 toolbar fits unclipped at 900x720", async () => {
  for (const locale of ["en", "zh"] as const) {
    const { app, fake } = await mountIssuesAt(900, 720, locale);

    expect(app.count("id:issue-filter-popover")).toBe(1);
    expect(app.count("id:issue-filter-bar")).toBe(0);

    const toolbar = app.layout("id:issues-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar!.height).toBeLessThanOrEqual(45);

    for (const id of ["issue-search", "issue-filter-popover", "issue-view", "display", "issue-refresh", "issue-toolbar-new"]) {
      const box = app.layout(`id:${id}`);
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(900);
      expect(box!.y + box!.height).toBeLessThanOrEqual(toolbar!.y + toolbar!.height + 1);
    }

    const filterBox = app.layout("id:issue-filter-popover")!;
    const viewBox = app.layout("id:issue-view")!;
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(viewBox.x);

    await app.press("id:issue-filter-popover");
    await fake.pumpUntil(app, () => app.count("id:issue-filter-popover-menu") === 1);
    expect(app.count("id:issue-scope")).toBe(1);
    expect(app.count("id:filter-repo")).toBe(1);
    expect(app.count("id:filter-agent")).toBe(1);
    expect(app.count("id:filter-tag")).toBe(1);
  }
});

test("IssueList renders compact #N ParentBadge below 1080px without bleeding over TagPills, and restores title at 1280px", async () => {
  const narrow = await mountIssuesAt(900, 720, "en");
  await narrow.app.press("id:issue-view-list");
  await narrow.fake.pumpUntil(narrow.app, () => narrow.app.count("id:row-parent-badge") === 1);

  expect(narrow.app.shows("id:row-parent-badge >> text:↳ #10")).toBe(true);
  expect(narrow.app.shows("id:row-parent-badge >> text:↳ #10 Extremely long parent initiative title for layout verification")).toBe(false);

  const badgeNarrow = narrow.app.layout("id:row-parent-badge")!;
  const tagsNarrow = narrow.app.layout("id:row-tags")!;
  expect(badgeNarrow.x + badgeNarrow.width).toBeLessThanOrEqual(tagsNarrow.x);

  const wide = await mountIssuesAt(1280, 800, "en");
  await wide.app.press("id:issue-view-list");
  await wide.fake.pumpUntil(wide.app, () => wide.app.count("id:row-parent-badge") === 1);

  expect(wide.app.shows("id:row-parent-badge >> text:↳ #10 Extremely long parent initiative title for layout verification")).toBe(true);
  const badgeWide = wide.app.layout("id:row-parent-badge")!;
  const tagsWide = wide.app.layout("id:row-tags")!;
  expect(badgeWide.x + badgeWide.width).toBeLessThanOrEqual(tagsWide.x);
});
