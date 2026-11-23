import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, RepoSummary, RuntimeInfo, SliceBundle } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../../app/fakeHost";
import { SCENARIO_NOW, type ScenarioDensity, scenarios } from "../../../fixtures/scenarios";

const sampleRepo: RepoSummary = {
  name: "vibevalley",
  path: "/Users/farmer/code/vibevalley",
  git: true,
  last: SCENARIO_NOW - 60_000,
  maxSessions: 3,
  pullRequest: { available: true, reason: "" },
};

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

const sampleRuntimeDisabled: RuntimeInfo = {
  ...sampleRuntimeReady,
  id: "codex",
  preset: { ...sampleRuntimeReady.preset, id: "codex", label: "Codex" },
  settings: { ...sampleRuntimeReady.settings, enabled: false },
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

test("0-issue onboarding tracks live 3-step readiness progression and navigates to setup routes", async () => {
  setLocale("zh");

  // 0 / 3 ready: empty repos and only unavailable/disabled runtimes.
  const step0 = await mountBoard("empty", (f) => {
    f.respond("repo.list", []);
    f.respond("runtime.list", [sampleRuntimeDisabled, sampleRuntimeNotFound]);
  });
  await step0.fake.pumpUntil(step0.app, () => step0.app.count("id:issues-empty-onboarding") === 1);
  expect(step0.app.count("id:onboarding-step-done-repos")).toBe(0);
  expect(step0.app.count("id:onboarding-step-done-runtimes")).toBe(0);
  expect(step0.app.count("id:onboarding-step-done-start")).toBe(0);
  expect(step0.app.texts()).toContain(t("web.issue.onboarding.progress", { done: 0, total: 3 }));

  await step0.app.press("id:onboarding-repos");
  await step0.fake.pumpUntil(step0.app, () => step0.app.count("id:repos-page") === 1);
  expect(step0.app.count("id:repos-page")).toBe(1);

  // 1 / 3 ready: repo added, runtime still missing.
  const step1 = await mountBoard("empty", (f) => {
    f.respond("repo.list", [sampleRepo]);
    f.respond("runtime.list", [sampleRuntimeNotFound]);
  });
  await step1.fake.pumpUntil(step1.app, () => step1.app.count("id:onboarding-step-done-repos") === 1);
  expect(step1.app.count("id:onboarding-step-done-runtimes")).toBe(0);
  expect(step1.app.texts()).toContain(t("web.issue.onboarding.progress", { done: 1, total: 3 }));
  expect(step1.app.texts()).toContain(t("web.issue.onboarding.step1Ready", { n: 1 }));

  await step1.app.press("id:onboarding-runtimes");
  await step1.fake.pumpUntil(step1.app, () => step1.app.count("id:runtimes-page") === 1);
  expect(step1.app.count("id:runtimes-page")).toBe(1);

  // 2 / 3 ready: both repo and ready runtime exist.
  const step2 = await mountBoard("empty", (f) => {
    f.respond("repo.list", [sampleRepo]);
    f.respond("runtime.list", [sampleRuntimeReady, sampleRuntimeNotFound]);
  });
  await step2.fake.pumpUntil(
    step2.app,
    () => step2.app.count("id:onboarding-step-done-repos") === 1 && step2.app.count("id:onboarding-step-done-runtimes") === 1,
  );
  expect(step2.app.count("id:onboarding-step-done-start")).toBe(0);
  expect(step2.app.texts()).toContain(t("web.issue.onboarding.progress", { done: 2, total: 3 }));
  expect(step2.app.texts()).toContain(t("web.issue.onboarding.step2Ready", { n: 1 }));
});

test("onboarding starter templates pre-fill NewIssue cleanly and enable immediate submission", async () => {
  setLocale("zh");
  const created: { title?: string }[] = [];
  const { app, fake } = await mountBoard("empty", (f) => {
    f.respond("repo.list", [sampleRepo]);
    f.respond("runtime.list", [sampleRuntimeReady]);
    const sampleIssue = makeTodoIssue("i-tpl", "starter");
    f.respond("issue.create", (payload: unknown) => {
      created.push(payload as { title?: string });
      return { ...sampleIssue, seq: scenarios.empty.state.seq + created.length };
    });
    f.respond("issue.refine", () => ({ ...sampleIssue, seq: scenarios.empty.state.seq + created.length + 1 }));
  });

  await fake.pumpUntil(app, () => app.count("id:onboarding-template-bug") === 1);
  expect(app.count("id:onboarding-template-feature")).toBe(1);
  expect(app.count("id:onboarding-template-refactor")).toBe(1);

  await app.press("id:onboarding-template-feature");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  expect(app.value("id:issue-new-text")).toBe(t("web.issue.onboarding.templates.feature.prompt"));
  expect(app.enabled("id:issue-new-keep")).toBe(true);
  await app.press("id:issue-new-dialog-never");
  expect(app.count("id:issue-new-dialog")).toBe(0);

  await app.press("id:onboarding-template-refactor");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  expect(app.value("id:issue-new-text")).toBe(t("web.issue.onboarding.templates.refactor.prompt"));
  await app.press("id:issue-new-dialog-never");

  await app.press("id:onboarding-template-bug");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  expect(app.value("id:issue-new-text")).toBe(t("web.issue.onboarding.templates.bug.prompt"));
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  expect(created[0]?.title).toBe(t("web.issue.onboarding.templates.bug.prompt"));
});

test("workflow guide strip shows 4 stages and persists collapse state across reload", async () => {
  setLocale("zh");
  const first = await mountBoard("typical");

  expect(first.app.count("id:workflow-guide")).toBe(1);
  expect(first.app.count("id:workflow-guide-body")).toBe(1);
  expect(first.app.count("id:workflow-stage-todo")).toBe(1);
  expect(first.app.count("id:workflow-stage-working")).toBe(1);
  expect(first.app.count("id:workflow-stage-waiting")).toBe(1);
  expect(first.app.count("id:workflow-stage-closed")).toBe(1);

  await first.app.press("id:workflow-guide-toggle");
  expect(first.app.count("id:workflow-guide-body")).toBe(0);

  await first.app.waitUntil(() => first.app.storage()["vibevalley.board.workflowGuide.collapsed"] === "true");
  const persisted = first.app.storage();

  const reloaded = await mountBoard("typical", undefined, { storage: persisted });
  await reloaded.app.waitUntil(() => reloaded.app.count("id:workflow-guide") === 1 && reloaded.app.count("id:workflow-guide-body") === 0);
  expect(reloaded.app.count("id:workflow-guide-body")).toBe(0);

  await reloaded.app.press("id:workflow-guide-toggle");
  expect(reloaded.app.count("id:workflow-guide-body")).toBe(1);
  await reloaded.app.waitUntil(() => reloaded.app.storage()["vibevalley.board.workflowGuide.collapsed"] === "false");
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

  // Filter with no matches switches empty lanes to the filtered hint.
  await min.app.type("id:issue-search", "no-matching-issue-xyz");
  expect(min.app.count("id:lane-empty-working")).toBe(1);
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.filtered"));

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
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:onboarding-new-issue") === 1);
  await bothMissing.app.press("id:onboarding-new-issue");
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
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:onboarding-new-issue") === 1);
  await bothMissing.app.press("id:onboarding-new-issue");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:issue-new-go-runtimes") === 1);
  await bothMissing.app.press("id:issue-new-go-runtimes");
  await bothMissing.fake.pumpUntil(bothMissing.app, () => bothMissing.app.count("id:runtimes-page") === 1);
  expect(bothMissing.app.count("id:issue-new-dialog")).toBe(0);

  // Only repo missing: shows repo callout + helper selector.
  const repoMissing = await mountBoard("empty", (f) => {
    f.respond("repo.list", []);
    f.respond("runtime.list", [sampleRuntimeReady]);
  });
  await repoMissing.fake.pumpUntil(repoMissing.app, () => repoMissing.app.count("id:onboarding-new-issue") === 1);
  await repoMissing.app.press("id:onboarding-new-issue");
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

test("english locale, dark theme, and narrow viewport render onboarding and workflow guide cleanly", async () => {
  setLocale("en");
  const emptyEn = await mountBoard("empty", undefined, { locale: "en", width: 560, height: 800 });
  await emptyEn.app.setColorScheme("dark");
  await emptyEn.fake.pumpUntil(emptyEn.app, () => emptyEn.app.count("id:issues-empty-onboarding") === 1);
  expect(emptyEn.app.texts()).toContain("Get started with VibeValley");
  expect(emptyEn.app.texts()).toContain("Fix a bug");
  expect(emptyEn.app.texts()).toContain("Add a feature");
  expect(emptyEn.app.texts()).toContain("Audit & refactor");

  const boardEn = await mountBoard("minimal", undefined, { locale: "en", width: 560, height: 800 });
  await boardEn.app.setColorScheme("dark");
  expect(boardEn.app.count("id:workflow-guide")).toBe(1);
  expect(boardEn.app.texts()).toContain("How issues flow");
  expect(boardEn.app.texts()).toContain("No to-dos yet");
});
