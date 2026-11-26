import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, RuntimeInfo, SliceBundle } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, type ScenarioDensity, scenarios } from "../../../fixtures/scenarios";

const sampleRuntimeReady: RuntimeInfo = {
  id: "claude",
  preset: {
    id: "claude",
    label: "Claude Code",
    blurb: "Anthropic coding engine",
    look: {
      species: "bear",
      outfit: "farmer",
      orchestrator: null,
      build: "biped",
      head: "rounded",
      body: "#b07a45",
      trim: "#3a2a18",
      hat: "#e8b84a",
      eye: "#a6f4ff",
    },
  },
  support: { steer: true, refused: {}, capabilities: ["listModels"], inProcess: false },
  installation: { status: "available", via: "executable", command: "/opt/homebrew/bin/claude", version: "2.1.4" },
  models: null,
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "opus", defaultEffort: "medium", env: {} },
  stop: "",
  checkedAt: SCENARIO_NOW - 60_000,
};

const sampleRuntimeNotFound: RuntimeInfo = {
  ...sampleRuntimeReady,
  id: "opencode",
  preset: { ...sampleRuntimeReady.preset, id: "opencode", label: "OpenCode" },
  installation: { status: "not_found" },
};

function makeTodoIssue(id: string, title: string, assignedAgent?: string): Issue {
  return {
    id: id as IssueId,
    number: 101,
    title,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["todo", "canceled"],
    priority: "medium",
    deliver: "change",
    repo: "vibevalley",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: assignedAgent ? [{ id: `assign-${id}`, issue: id as IssueId, agent: assignedAgent, assignedAt: SCENARIO_NOW - 240_000, executions: [] }] : [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 300_000,
    stage: { state: "draft", acts: [] },
  };
}

async function mountBoard(
  density: ScenarioDensity,
  configure?: (fake: FakeHost) => void,
  opts?: { locale?: "zh" | "en"; storage?: Record<string, string>; width?: number; height?: number; state?: SliceBundle },
) {
  const base = scenarios[density];
  const fixture = opts?.state ? { state: opts.state, responses: base.responses } : base;
  const fake = fakeHost(fixture, { route: "/issues", ...(opts?.locale ? { locale: opts.locale } : {}) });
  configure?.(fake);
  const app = await open("../../../app/main.tsx", {
    width: opts?.width ?? 1280,
    height: opts?.height ?? 820,
    colorScheme: "light",
    platform: "macos",
    storage: opts?.storage,
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

test("empty board always renders the unified toolbar, kanban columns, and calm empty list hint", async () => {
  setLocale("zh");
  const { app, fake } = await mountBoard("empty");

  await fake.pumpUntil(app, () => app.count("id:lane-empty-todo") === 1);
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:issues-empty-onboarding")).toBe(0);
  expect(app.count("id:issue-toolbar-new")).toBe(1);
  expect(app.count("id:workflow-guide")).toBe(0);
  expect(app.count("id:lane-todo")).toBe(1);
  expect(app.count("id:lane-working")).toBe(1);
  expect(app.count("id:lane-waiting")).toBe(1);
  expect(app.count("id:lane-closed")).toBe(1);

  // Switch to list view: shows a calm 1-line empty hint.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list-empty") === 1);
  expect(app.texts()).toContain(t("web.issue.list.empty"));

  // Typing a search query switches to the filtered empty hint.
  await app.type("id:issue-search", "missing-query");
  expect(app.texts()).toContain(t("web.issue.list.emptyFiltered"));
});

test("empty lanes render actionable contextual guidance and unassigned Todo cards show assign hint", async () => {
  setLocale("zh");

  // minimal has 1 working issue: todo, waiting, and closed lanes are empty.
  const min = await mountBoard("minimal");
  expect(min.app.count("id:lane-empty-todo")).toBe(1);
  expect(min.app.count("id:lane-empty-working")).toBe(0);
  expect(min.app.count("id:lane-empty-waiting")).toBe(1);
  expect(min.app.count("id:lane-empty-closed")).toBe(1);
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.todoTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.waitingTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.closedTitle"));

  // Quick "+ New issue" inside empty todo lane opens NewIssue.
  await min.app.press("id:lane-empty-todo >> id:issue-new");
  expect(min.app.count("id:issue-new-dialog")).toBe(1);
  await min.app.press("id:issue-new-dialog-never");

  // Filter with no matches switches empty lanes to the filtered hint and offers one-click reset.
  await min.app.type("id:issue-search", "no-matching-issue-xyz");
  expect(min.app.count("id:lane-empty-working")).toBe(1);
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.filtered"));
  expect(min.app.count("id:board-clear-filter")).toBe(1);
  expect(min.app.count("id:issue-search-clear")).toBe(1);
  await min.app.press("id:board-clear-filter");
  await min.fake.pumpUntil(min.app, () => min.app.count("id:issue-card") === 1);
  expect(min.app.value("id:issue-search")).toBe("");

  // Custom board with 1 unassigned todo + 1 assigned todo: working/waiting/closed empty, unassigned hint appears once.
  const unassigned = makeTodoIssue("i-unassigned", "需要认领的待办");
  const assigned = makeTodoIssue("i-assigned", "已指派角色的待办", "laozhou");
  const customState: SliceBundle = {
    ...scenarios.empty.state,
    board: {
      seq: 2,
      issues: [unassigned, assigned],
    },
  };
  const todoBoard = await mountBoard(
    "typical",
    (f) => {
      f.respond("issue.history.list", [
        { issue: unassigned, sessions: [], missingSessions: [] },
        { issue: assigned, sessions: [], missingSessions: [] },
      ]);
    },
    { state: customState },
  );
  await todoBoard.fake.pumpUntil(todoBoard.app, () => todoBoard.app.count("id:issue-card") === 2);
  expect(todoBoard.app.count("id:lane-empty-working")).toBe(1);
  expect(todoBoard.app.texts()).toContain(t("web.issue.board.emptyGuide.workingTitle"));
  expect(todoBoard.app.count("id:card-unassigned")).toBe(1);
  expect(todoBoard.app.texts()).toContain(t("web.issue.card.assignHelper"));
});

test("NewIssue replaces missing repo/runtime selectors with actionable inline navigation callouts", async () => {
  setLocale("zh");

  // Both missing: replaces selectors with warn banners linking to /repos and /runtimes.
  const bothMissing = await mountBoard("empty", (f) => {
    f.respond("repo.list", []);
    f.respond("runtime.list", [sampleRuntimeNotFound]);
  });
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:issue-toolbar-new") === 1);
  await bothMissing.app.press("id:issue-toolbar-new");
  await bothMissing.fake.pumpUntil(
    bothMissing.app,
    () => bothMissing.app.count("id:issue-new-missing-repo") === 1 && bothMissing.app.count("id:issue-new-missing-runtime") === 1,
  );
  expect(bothMissing.app.count("id:issue-new-repo")).toBe(0);
  expect(bothMissing.app.count("id:issue-new-helper")).toBe(0);

  await bothMissing.app.press("id:issue-new-go-repos");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:repos-page") === 1);
  expect(bothMissing.app.count("id:issue-new-dialog")).toBe(0);

  // Navigate back and jump to /runtimes via inline callout.
  await bothMissing.app.host.send("route", "/issues");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:issue-toolbar-new") === 1);
  await bothMissing.app.press("id:issue-toolbar-new");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:issue-new-go-runtimes") === 1);
  await bothMissing.app.press("id:issue-new-go-runtimes");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:runtimes-page") === 1);
  expect(bothMissing.app.count("id:issue-new-dialog")).toBe(0);

  // Only repo missing: shows repo callout + helper selector.
  const repoMissing = await mountBoard("empty", (f) => {
    f.respond("repo.list", []);
    f.respond("runtime.list", [sampleRuntimeReady]);
  });
  await repoMissing.fake.pumpUntil(repoMissing.app, () => repoMissing.app.count("id:issue-toolbar-new") === 1);
  await repoMissing.app.press("id:issue-toolbar-new");
  await repoMissing.fake.pumpUntil(repoMissing.app, () => repoMissing.app.count("id:issue-new-missing-repo") === 1);
  expect(repoMissing.app.count("id:issue-new-repo")).toBe(0);
  expect(repoMissing.app.count("id:issue-new-missing-runtime")).toBe(0);
  expect(repoMissing.app.count("id:issue-new-helper")).toBe(1);

  // Both ready: shows both selectors and zero warning callouts.
  const allReady = await mountBoard("typical");
  await allReady.app.press("id:issue-new");
  await allReady.fake.pumpUntil(allReady.app, () => allReady.app.count("id:issue-new-dialog") === 1);
  expect(allReady.app.count("id:issue-new-repo")).toBe(1);
  expect(allReady.app.count("id:issue-new-helper")).toBe(1);
  expect(allReady.app.count("id:issue-new-missing-repo")).toBe(0);
  expect(allReady.app.count("id:issue-new-missing-runtime")).toBe(0);
});

test("english locale, dark theme, and narrow viewport render empty board cleanly", async () => {
  setLocale("en");
  const emptyEn = await mountBoard("empty", undefined, { locale: "en", width: 560, height: 800 });
  await emptyEn.app.setColorScheme("dark");
  await emptyEn.fake.pumpUntil(emptyEn.app, () => emptyEn.app.count("id:lane-empty-todo") === 1);
  expect(emptyEn.app.count("id:issues-empty-onboarding")).toBe(0);
  expect(emptyEn.app.count("id:workflow-guide")).toBe(0);
  expect(emptyEn.app.texts()).toContain("No to-dos yet");
});

test("IssueList empty-filter CTA resets search and IssueDetail copies issue reference", async () => {
  setLocale("zh");
  const { app, fake } = await mountBoard("typical");

  await fake.pumpUntil(app, () => app.count("id:issue-card") > 0);
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list") === 1);
  await app.type("id:issue-search", "no-matching-list-xyz");
  await fake.pumpUntil(app, () => app.count("id:issue-list-clear-filter") === 1);
  await app.press("id:issue-list-clear-filter");
  await fake.pumpUntil(app, () => app.count("id:issue-list-clear-filter") === 0);
  expect(app.value("id:issue-search")).toBe("");

  const workingIssue = scenarios.typical.state.board.issues.find((i) => i.status === "in_progress" || i.status === "in_review" || i.status === "done");
  if (!workingIssue) throw new Error("typical scenario must include an active or closed issue");
  await app.host.send("route", `/issues/${workingIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-copy-id") === 1);
  await app.press("id:issue-copy-id");
  await fake.pumpUntil(app, () => app.clipboard() === `#${workingIssue.number}`);
  expect(app.texts()).toContain(t("web.base.rich.copied"));
});
