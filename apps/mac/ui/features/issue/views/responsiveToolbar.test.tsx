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
    expect(app.count("id:issue-layout-bar")).toBe(0);

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
    expect(app.count("id:group-by")).toBe(0);
    expect(app.count("id:hierarchy-mode")).toBe(0);

    await app.keyboard.press("escape");
    await fake.pumpUntil(app, () => app.count("id:issue-filter-popover-menu") === 0);

    // Unified DisplayMenu opens cleanly at 900px without clipping and owns groupBy/hierarchy/density/fields.
    await app.press("id:display");
    await fake.pumpUntil(app, () => app.count("id:display-menu") === 1);
    expect(app.count("id:group-by")).toBe(1);
    expect(app.count("id:hierarchy-mode")).toBe(1);
    expect(app.count("id:density")).toBe(1);
    const menuBox = app.layout("id:display-menu")!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(900);
  }
});

test("IssuesPage wraps toolbar into two non-overlapping rows at 560px and 720px and keeps wide filters collapsed into popover at 1280px", async () => {
  for (const width of [560, 720]) {
    for (const locale of ["en", "zh"] as const) {
      const { app } = await mountIssuesAt(width, 800, locale);
      const searchBox = app.layout("id:issue-search")!;
      const filterBox = app.layout("id:issue-filter-popover")!;
      const refreshBox = app.layout("id:issue-refresh")!;
      const newBox = app.layout("id:issue-toolbar-new")!;
      const viewBox = app.layout("id:issue-view")!;
      const displayBox = app.layout("id:display")!;

      // Row 1 controls fit left-to-right with zero horizontal overlap.
      expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(filterBox.x + 1);
      expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(refreshBox.x + 1);
      expect(refreshBox.x + refreshBox.width).toBeLessThanOrEqual(newBox.x + 1);
      expect(newBox.x + newBox.width).toBeLessThanOrEqual(width);

      // Row 2 sits cleanly below Row 1 with zero overlap between view switcher and DisplayMenu.
      expect(viewBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height - 1);
      expect(viewBox.x + viewBox.width).toBeLessThanOrEqual(displayBox.x + 1);
      expect(displayBox.x + displayBox.width).toBeLessThanOrEqual(width);

      // VDP view switcher testIDs remain intact.
      for (const id of ["issues-page", "issue-view-board", "issue-view-list", "issue-view-timeline", "issue-view-calendar"]) {
        expect(app.count(`id:${id}`)).toBe(1);
      }
    }
  }

  // Wide 1280px toolbar collapses the 4 dropdowns into issue-filter-popover rather than an inline filter bar.
  const wide = await mountIssuesAt(1280, 820, "zh");
  expect(wide.app.count("id:issue-filter-bar")).toBe(0);
  expect(wide.app.count("id:issue-filter-popover")).toBe(1);
  expect(wide.app.count("id:issue-scope")).toBe(1);
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
