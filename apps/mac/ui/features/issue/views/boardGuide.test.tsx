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
  expect(app.count("id:lane-backlog")).toBe(1);
  expect(app.count("id:lane-todo")).toBe(1);
  expect(app.count("id:lane-in_progress")).toBe(1);
  expect(app.count("id:lane-in_review")).toBe(1);
  expect(app.count("id:lane-done")).toBe(1);
  expect(app.count("id:lane-canceled")).toBe(1);

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

  // minimal has 1 in_progress issue: backlog, todo, in_review, done, and canceled lanes are empty.
  const min = await mountBoard("minimal");
  expect(min.app.count("id:lane-empty-backlog")).toBe(1);
  expect(min.app.count("id:lane-empty-todo")).toBe(1);
  expect(min.app.count("id:lane-empty-in_progress")).toBe(0);
  expect(min.app.count("id:lane-empty-in_review")).toBe(1);
  expect(min.app.count("id:lane-empty-done")).toBe(1);
  expect(min.app.count("id:lane-empty-canceled")).toBe(1);
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.backlogTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.todoTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.in_reviewTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.doneTitle"));
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.canceledTitle"));

  // Quick "+ New issue" inside empty todo lane opens NewIssue.
  await min.app.press("id:lane-empty-todo >> id:issue-new");
  expect(min.app.count("id:issue-new-dialog")).toBe(1);
  await min.app.press("id:issue-new-dialog-never");

  // Filter with no matches switches empty lanes to the filtered hint and offers one-click reset.
  await min.app.type("id:issue-search", "no-matching-issue-xyz");
  expect(min.app.count("id:lane-empty-in_progress")).toBe(1);
  expect(min.app.texts()).toContain(t("web.issue.board.emptyGuide.filtered"));
  expect(min.app.count("id:board-clear-filter")).toBe(1);
  expect(min.app.count("id:issue-search-clear")).toBe(1);
  await min.app.press("id:board-clear-filter");
  await min.fake.pumpUntil(min.app, () => min.app.count("id:issue-card") === 1);
  expect(min.app.value("id:issue-search")).toBe("");

  // Custom board with 1 unassigned todo + 1 assigned todo: in_progress/in_review/done/canceled empty, unassigned hint appears once.
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
  expect(todoBoard.app.count("id:lane-empty-in_progress")).toBe(1);
  expect(todoBoard.app.texts()).toContain(t("web.issue.board.emptyGuide.in_progressTitle"));
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
  await emptyEn.fake.pumpUntil(emptyEn.app, () => emptyEn.app.count("id:lane-empty-backlog") === 1);
  expect(emptyEn.app.count("id:issues-empty-onboarding")).toBe(0);
  expect(emptyEn.app.count("id:workflow-guide")).toBe(0);
  expect(emptyEn.app.texts()).toContain("Backlog is empty");
  await emptyEn.app.press("id:board-lane-tab-todo");
  await emptyEn.fake.pumpUntil(emptyEn.app, () => emptyEn.app.count("id:lane-empty-todo") === 1);
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

test("regression: todo add button renders in lane header above cards and dragging a card does not open it", async () => {
  setLocale("zh");
  const first = makeTodoIssue("i-drag-1", "第一张工单", "laozhou");
  const second = makeTodoIssue("i-drag-2", "第二张工单");
  const customState: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 2, issues: [first, second] },
  };
  const { app, fake } = await mountBoard(
    "typical",
    (f) => {
      f.respond("issue.history.list", [
        { issue: first, sessions: [], missingSessions: [] },
        { issue: second, sessions: [], missingSessions: [] },
      ]);
    },
    { state: customState },
  );
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 2 && app.count("id:issue-new") === 1);

  const firstCardBox = app.layout("id:issue-card >> nth=0");
  const newBtnBox = app.layout("id:issue-new");
  expect(firstCardBox).toBeDefined();
  expect(newBtnBox).toBeDefined();
  expect(newBtnBox!.y + newBtnBox!.height).toBeLessThanOrEqual(firstCardBox!.y);

  // Dragging a card (even across lanes) must not open Quick-Peek or full detail.
  const secondBox = app.layout("id:issue-card >> nth=1")!;
  const workingBox = app.layout("id:lane-in_progress")!;
  await app.drag("id:issue-card >> nth=1", { x: workingBox.x + workingBox.width / 2 - (secondBox.x + secondBox.width / 2), y: 0 });
  await fake.pump(app);
  expect(app.count("id:issue-peek-modal")).toBe(0);
  expect(app.count("id:issue")).toBe(0);

  // Advance virtual clock past the post-drag click suppression window: plain click opens Quick-Peek, then Expand opens full screen.
  await app.wait(350);
  await app.press("id:issue-card >> nth=1");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.count("id:issue")).toBe(0);

  await app.press("id:issue-peek-expand");
  await fake.pumpUntil(app, () => app.count("id:issue") === 1);
  expect(app.count("id:issue-peek-modal")).toBe(0);
});

test("NewIssue unified AgentSelect surfaces agent.validate readiness diagnostics", async () => {
  setLocale("zh");
  const { app, fake } = await mountBoard("typical", (f) => {
    f.respond("agent.validate", [{ id: "xiaolin", problems: [{ field: "runtime", level: "error", text: "Codex 未配置密钥" }] }]);
  });
  await fake.pumpUntil(app, () => app.count("id:issue-new") === 1);
  await app.press("id:issue-new");
  await fake.pumpUntil(app, () => app.count("id:issue-new-helper") === 1);

  // Choose an enabled helper whose validation has an error problem -> inline diagnostic displays error text.
  await app.press("id:issue-new-helper");
  await fake.pump(app);
  expect(app.texts()).toContain("小林");
  expect(app.texts()).toContain("Codex 未配置密钥");
  await app.press("id:issue-new-helper-option-xiaolin");
  await fake.pumpUntil(app, () => app.count("id:issue-new-helper-status") === 1);
  expect(app.texts()).toContain("Codex 未配置密钥");

  // Choose a ready agent -> shows ready status instead of problem text.
  await app.press("id:issue-new-helper");
  await fake.pump(app);
  await app.press("id:issue-new-helper-option-laozhou");
  await fake.pump(app);
  expect(app.texts()).toContain("就绪");
});

test("6-lane Kanban fits all 6 lanes at 1680px and renders 5 unclipped lanes at 1280px", async () => {
  setLocale("zh");
  const wide = await mountBoard("typical", undefined, { width: 1680, height: 820 });
  await wide.fake.pumpUntil(wide.app, () => wide.app.count("id:lane-canceled") === 1);
  const canceled1680 = wide.app.layout("id:lane-canceled")!;
  const backlog1680 = wide.app.layout("id:lane-backlog")!;
  expect(backlog1680.x).toBeGreaterThanOrEqual(76);
  expect(canceled1680.x + canceled1680.width).toBeLessThanOrEqual(1680);

  const laptop = await mountBoard("typical", undefined, { width: 1280, height: 820 });
  await laptop.fake.pumpUntil(laptop.app, () => laptop.app.count("id:lane-done") === 1);
  const scroll1280 = laptop.app.layout("id:board-scroll")!;
  const done1280 = laptop.app.layout("id:lane-done")!;
  const canceled1280 = laptop.app.layout("id:lane-canceled")!;
  expect(done1280.x + done1280.width).toBeLessThanOrEqual(scroll1280.x + scroll1280.width + 1);
  expect(canceled1280.x).toBeGreaterThanOrEqual(scroll1280.x + scroll1280.width);
});

test("regression: Board cards and List rows omit full-body hover tooltips while keeping field micro-tooltips", async () => {
  setLocale("zh");
  const item: Issue = {
    ...makeTodoIssue("i-hover-clean", "Clean card without full-body pop tip", "laozhou"),
    attachments: [{ id: "att-1", name: "spec.png", type: "image/png", size: 1024 }],
  };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 5, issues: [item] },
  };
  const { app, fake } = await mountBoard(
    "typical",
    (f) => {
      f.respond("issue.history.list", [{ issue: item, sessions: [], missingSessions: [] }]);
    },
    { state },
  );
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 1 && app.count("id:card-attachments") === 1);

  // Hovering the Board card past Bubble delay (300ms) must not pop up cardLook.detail ("写于 …").
  await app.hover("id:issue-card");
  await app.wait(400);
  const boardHoverTexts = app.texts().join("\n");
  expect(boardHoverTexts).not.toContain("写于 ");
  expect(boardHoverTexts).not.toContain(t("web.issue.card.pickFirst"));

  // Hovering the attachment micro-badge still renders its concise tooltip.
  await app.hover("id:card-attachments");
  await app.wait(400);
  expect(app.texts()).toContain(t("web.issue.attachments.count", { n: 1 }));

  // Switch to List view: hovering the row must not render full-body detail overlay, while micro-tooltips remain.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list") === 1 && app.count("id:row-attachments") === 1);
  await app.hover("id:issue-card");
  await app.wait(400);
  const listHoverTexts = app.texts().join("\n");
  expect(listHoverTexts).not.toContain("写于 ");
  expect(listHoverTexts).not.toContain(t("web.issue.card.pickFirst"));

  await app.hover("id:row-attachments");
  await app.wait(400);
  expect(app.texts()).toContain(t("web.issue.attachments.count", { n: 1 }));
});

test("Kanban drag-and-drop persists exact cross-lane and same-lane insertion slots", async () => {
  setLocale("zh");
  const b1: Issue = {
    ...makeTodoIssue("i-b1", "Backlog 待拖入卡片", "laozhou"),
    number: 201,
    status: "backlog",
    moves: ["backlog", "todo", "done", "canceled"],
  };
  const t1: Issue = { ...makeTodoIssue("i-t1", "Todo 第一张", "laozhou"), number: 202, status: "todo", moves: ["backlog", "todo", "done", "canceled"] };
  const t2: Issue = { ...makeTodoIssue("i-t2", "Todo 第二张", "laozhou"), number: 203, status: "todo", moves: ["backlog", "todo", "done", "canceled"] };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 10, issues: [b1, t1, t2] },
  };
  const statusCalls: unknown[] = [];
  const updateCalls: unknown[] = [];
  const { app, fake } = await mountBoard(
    "typical",
    (f) => {
      f.respond("issue.history.list", [
        { issue: b1, sessions: [], missingSessions: [] },
        { issue: t1, sessions: [], missingSessions: [] },
        { issue: t2, sessions: [], missingSessions: [] },
      ]);
      f.respond("issue.status.update", (input: unknown) => {
        statusCalls.push(input);
        return { issue: { ...b1, status: "todo" }, seq: 11 };
      });
      f.respond("issue.update", (input: unknown) => {
        updateCalls.push(input);
        return { ...t1 };
      });
    },
    { state },
  );
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 3);

  // Cross-lane drag: backlog card -> top half of todo's second card (inserts between t1 and t2).
  const b1Box = app.layout("id:lane-backlog >> id:issue-card >> nth=0")!;
  const t2Box = app.layout("id:lane-todo >> id:issue-card >> nth=1")!;
  await app.drag("id:lane-backlog >> id:issue-card >> nth=0", {
    x: t2Box.x + t2Box.width / 2 - (b1Box.x + b1Box.width / 2),
    y: t2Box.y + t2Box.height * 0.25 - (b1Box.y + b1Box.height / 2),
  });
  await fake.pump(app);
  expect(statusCalls.length).toBe(1);
  expect(statusCalls[0]).toMatchObject({ id: "i-b1", status: "todo", edit: { before: "i-t2" } });

  // Same-lane drag: move t1 below t2's vertical midline -> appends to end (`before: ""`).
  await app.wait(350);
  const t1Box = app.layout("id:lane-todo >> id:issue-card >> nth=0")!;
  const lastBox = app.layout("id:lane-todo >> id:issue-card >> nth=2")!;
  await app.drag("id:lane-todo >> id:issue-card >> nth=0", {
    x: 0,
    y: lastBox.y + lastBox.height * 0.85 - (t1Box.y + t1Box.height / 2),
  });
  await fake.pump(app);
  expect(updateCalls.length).toBe(1);
  expect(updateCalls[0]).toMatchObject({ id: "i-t1", before: "" });
});
