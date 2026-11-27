import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, Session, SessionId, SliceBundle } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

const LONG_TITLE = "Polish mobile responsive layout for remote worktree session view";

function makeIssueFixture(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number; title: string }): Issue {
  return {
    description: "Ensure long titles stay intact across cards and detail views.",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "in_review",
    moves: ["todo", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: ["Header displays the full issue title", "Unchecked criterion circle remains visible"],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 600_000,
    stage: { state: "stuck", stuck: "failed", acts: [{ act: "resume", does: "move", status: "todo", words: "optional" }], lead: "resume" },
    ...overrides,
    id: overrides.id as IssueId,
  };
}

function makeFailedSession(id: string, summary: string): Session {
  return {
    id: id as SessionId,
    controller: "issueBoard",
    role: "worker",
    name: "老周",
    profile: "laozhou",
    runtime: "vibevalley",
    policy: { kind: "sandboxDir" },
    bindings: [],
    phase: { _tag: "resting" },
    hiredAt: SCENARIO_NOW - 300_000,
    brief: LONG_TITLE,
    runs: 1,
    lastRun: { outcome: "failed", summary, at: SCENARIO_NOW - 60_000 },
  };
}

test("IssueDetail shows full unclamped title, omits empty repo crumb, localizes API-key error with Settings link, and renders compact empty attach button", async () => {
  setLocale("zh");
  const session = makeFailedSession("s-apikey", "no API key is set for the model");
  const issue = makeIssueFixture({
    id: "i-ux-1",
    number: 4,
    title: LONG_TITLE,
    assignments: [
      {
        id: "assign-1",
        issue: "i-ux-1" as IssueId,
        agent: "laozhou",
        assignedAt: SCENARIO_NOW - 300_000,
        executions: [{ kind: "worker", session: session.id, startedAt: SCENARIO_NOW - 300_000 }],
      },
    ],
  });

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 10, issues: [issue] },
    sessions: { ...scenarios.empty.state.sessions, sessions: [] },
  };

  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${issue.id}`, locale: "zh" });
  fake.respond("issue.history.list", [{ issue, sessions: [session], missingSessions: [] }]);
  fake.respond("issue.timeline.get", {
    milestones: [
      { at: SCENARIO_NOW - 600_000, kind: "opened", text: "开了这个工单" },
      { at: SCENARIO_NOW - 60_000, kind: "failed", who: "老周", text: "没做成", said: "no API key is set for the model" },
    ],
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-title") === 1);

  const texts = app.texts();
  // Full title (> 40 chars) is preserved intact without truncation.
  expect(texts).toContain(LONG_TITLE);
  // Breadcrumb omits "没有仓库" and cleanly shows #4.
  expect(app.count("id:issue-trail")).toBe(1);
  expect(app.count("id:issue-trail >> text:#4")).toBe(1);
  expect(app.count(`id:issue-trail >> text:${t("web.issue.detail.noRepo")}`)).toBe(0);
  // Unchecked criteria circles are rendered with testID.
  expect(app.count("id:criterion-unsaid")).toBe(2);
  // Empty attachments section collapses into compact attach button without orphaned count.
  expect(app.count("id:issue-attachments")).toBe(1);
  expect(app.count("id:issue-attach-file")).toBe(1);
  expect(app.count("id:issue-attachments-count")).toBe(0);
  // Raw English API key error is localized everywhere and offers a Settings link.
  expect(texts.join("\n")).not.toContain("no API key is set");
  expect(texts).toContain(t("web.issue.error.missingApiKey"));
  expect(app.count("id:issue-error-settings")).toBe(1);
  // Active ask action card is elevated above the issue description, and criteria render a progress bar.
  const askBox = app.layout("id:issue-ask");
  const reqBox = app.layout("id:issue-requirement");
  expect(askBox).toBeDefined();
  expect(reqBox).toBeDefined();
  expect(askBox!.y + askBox!.height).toBeLessThanOrEqual(reqBox!.y);
  expect(app.count("id:issue-progress-bar")).toBe(1);
  // Without a thread channel in collab slice, inline comment composer is gracefully omitted.
  expect(app.count("id:issue-comment-composer")).toBe(0);

  await app.press("id:issue-error-settings");
  await fake.pumpUntil(app, () => app.count("id:settings-models") === 1);
});

test("IssueDetail renders inline comment composer when an issue thread channel exists", async () => {
  setLocale("zh");
  const session = makeFailedSession("s-thread", "waiting for review");
  const issue = makeIssueFixture({
    id: "i-thread-1",
    number: 18,
    title: "Add inline comment box to issue discussion",
    assignments: [
      {
        id: "assign-thread",
        issue: "i-thread-1" as IssueId,
        agent: "laozhou",
        assignedAt: SCENARIO_NOW - 300_000,
        executions: [{ kind: "worker", session: session.id, startedAt: SCENARIO_NOW - 300_000 }],
      },
    ],
  });
  const threadChannel = {
    id: "ch-issue-18",
    name: "#18",
    title: issue.title,
    description: "",
    category: "issues",
    type: "thread" as const,
    default: false,
    notify: "all" as const,
    replies: 0,
    at: SCENARIO_NOW - 300_000,
    subjectKind: "issue" as const,
    subjectId: issue.id,
    members: [],
  };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 12, issues: [issue] },
    collab: {
      ...scenarios.empty.state.collab,
      chat: {
        channels: [threadChannel],
        userMentions: [],
      },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${issue.id}`, locale: "zh" });
  fake.respond("issue.history.list", [{ issue, sessions: [session], missingSessions: [] }]);
  fake.respond("issue.conversation.get", threadChannel.id);
  fake.respond("channel.message.list", []);

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-comment-composer") === 1);
  expect(app.count("id:issue-comment-composer >> id:composer-input")).toBe(1);
});

test("Board integrates filter bar, preserves long card titles, and suppresses unassigned badge on backlog drafts", async () => {
  setLocale("zh");
  const draftIssue = makeIssueFixture({
    id: "i-draft-ux",
    number: 11,
    title: LONG_TITLE,
    status: "backlog",
    stage: { state: "draft", acts: [] },
  });
  const readyTodo = makeIssueFixture({
    id: "i-todo-ux",
    number: 12,
    title: "Confirmed todo needing a helper",
    status: "todo",
    stage: { state: "draft", acts: [] },
  });

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 11, issues: [draftIssue, readyTodo] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.history.list", [
    { issue: draftIssue, sessions: [], missingSessions: [] },
    { issue: readyTodo, sessions: [], missingSessions: [] },
  ]);

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 2);

  // Filter icon and selects are unified in one filter bar.
  expect(app.count("id:issue-filter-bar")).toBe(1);
  // Full title is passed to board card (clamped visually via line-clamp-2, not truncated at 40 chars).
  expect(app.texts()).toContain(LONG_TITLE);
  // Only the confirmed todo shows card-unassigned; backlog draft avoids double badge noise.
  expect(app.count("id:card-unassigned")).toBe(1);

  // Switch to List view: empty status groups omit the body container and stay compact without hollow bars.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list") === 1);

  // Backlog and Todo each have 1 issue; in_progress/in_review/done/canceled are empty (0 rows) and render no group body.
  expect(app.count("id:issue-group")).toBe(6);
  expect(app.count("id:issue-group-body")).toBe(2);
  expect(app.count("id:issue-group-backlog")).toBe(1);
  expect(app.count("id:issue-group-todo")).toBe(1);
  expect(app.count("id:issue-group-in_progress")).toBe(1);
  expect(app.count("id:issue-group-in_review")).toBe(1);
});

test("Board uses professional PM lane labels without concurrency badge, renders card thumbnails, and opens Quick-Peek modal", async () => {
  setLocale("zh");
  const compareDesc = [
    "Visual audit for Kanban cards:",
    "```compare",
    JSON.stringify({
      title: "Board Card Polish",
      before: { attachment: "att-before", label: "Before" },
      after: { attachment: "att-after", label: "After" },
    }),
    "```",
  ].join("\n");
  const compareIssue = makeIssueFixture({
    id: "i-compare-card",
    number: 21,
    title: "Compare card with Before/After thumbnail",
    description: compareDesc,
    status: "backlog",
    repo: "vibevalley",
    stage: { state: "draft", acts: [] },
  });
  const imageIssue = makeIssueFixture({
    id: "i-image-card",
    number: 22,
    title: "Card with plain image attachment",
    description: "Verify image thumbnail rendering on board card.",
    status: "backlog",
    repo: "vibevalley",
    attachments: [{ id: "att-shot", name: "preview.png", type: "image/png", size: 4096 }],
    stage: { state: "draft", acts: [] },
  });

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: {
      seq: 15,
      issues: [compareIssue, imageIssue],
      boardSummary: {
        laneCounts: { backlog: 2, todo: 0, inProgress: 0, inReview: 0, done: 0, canceled: 0 },
        runningSlots: 0,
        maxRunning: 3,
        byIssue: {
          [compareIssue.id]: {
            lane: "backlog",
            cardKind: "todo",
            familyDone: 0,
            familyTotal: 0,
            needsWorktreeCheck: false,
            preview: { attachmentId: "att-after", isCompare: true },
          },
          [imageIssue.id]: {
            lane: "backlog",
            cardKind: "todo",
            familyDone: 0,
            familyTotal: 0,
            needsWorktreeCheck: false,
            preview: { attachmentId: "att-shot", isCompare: false },
          },
        },
      },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.history.list", [
    { issue: compareIssue, sessions: [], missingSessions: [] },
    { issue: imageIssue, sessions: [], missingSessions: [] },
  ]);
  fake.respond("attachment.file", (payload: unknown) => {
    const id = (payload as { id?: string } | undefined)?.id ?? "";
    return { path: `/tmp/${id}.png`, type: "image/png", name: `${id}.png` };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:card-preview") === 2);

  // Professional PM lane labels and no 0/6 concurrency counter badge.
  const texts = app.texts();
  expect(texts).toContain("待办");
  expect(texts).toContain("进行中");
  expect(texts).toContain("待验收");
  expect(texts).toContain("已完成");
  expect(app.count("id:lane-working-slots")).toBe(0);

  // Compare card carries the subtle Compare badge; plain image attachment does not.
  expect(app.count("id:card-preview-compare")).toBe(1);

  // Clicking a card opens Quick-Peek modal with responsive viewport scaling and preview-first Compare content, dismissible via Close, or expandable to full screen.
  await app.press("id:issue-card >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1 && app.count("id:compare-card") === 1);
  const peekBox = app.layout("id:issue-peek-surface");
  expect(peekBox).toBeDefined();
  expect(peekBox!.width).toBe(1124);
  expect(peekBox!.height).toBe(720);
  expect(app.count("id:issue")).toBe(0);
  expect(app.count("id:issue-peek-expand")).toBe(1);

  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // Reopen via list view and click Expand to transition into full-screen IssueView.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list") === 1);
  await app.press("id:issue-card >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  await app.press("id:issue-peek-expand");
  await fake.pumpUntil(app, () => app.count("id:issue") === 1);
  expect(app.count("id:issue-peek-modal")).toBe(0);
});

test("Board renders tags, parent badges, scope toggle, and TodoDetail supports triage, tags, parent, sub-issues, and dates", async () => {
  setLocale("zh");
  const parentIssue = makeIssueFixture({
    id: "i-parent-10",
    number: 10,
    title: "Parent epic issue",
    status: "backlog",
    tags: ["架构", "MCP"],
    startAt: Date.UTC(2026, 10, 26),
    dueAt: Date.UTC(2026, 11, 5),
    stage: { state: "draft", acts: [] },
  });
  const childIssue = makeIssueFixture({
    id: "i-child-11",
    number: 11,
    title: "Child backlog issue",
    status: "backlog",
    parent: parentIssue.id,
    tags: ["UX"],
    stage: { state: "draft", acts: [] },
  });
  const canceledIssue = makeIssueFixture({
    id: "i-canceled-12",
    number: 12,
    title: "Discarded idea",
    status: "canceled",
    stage: { state: "canceled", acts: [] },
  });

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 20, issues: [parentIssue, childIssue, canceledIssue] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.history.list", [
    { issue: parentIssue, sessions: [], missingSessions: [] },
    { issue: childIssue, sessions: [], missingSessions: [] },
    { issue: canceledIssue, sessions: [], missingSessions: [] },
  ]);
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { id: string; startAt?: number; dueAt?: number };
    return { ...childIssue, id: p.id as IssueId, startAt: p.startAt, dueAt: p.dueAt, seq: 21 };
  });
  fake.respond("issue.status.update", (payload: unknown) => {
    const p = payload as { id: string; status: Issue["status"] };
    return { ...childIssue, id: p.id as IssueId, status: p.status, seq: 22 };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 3);

  // Tags, parent badge, refresh button, and scope/tag filter controls exist.
  expect(app.count("id:issue-scope")).toBe(1);
  expect(app.count("id:filter-tag")).toBe(1);
  expect(app.count("id:issue-refresh")).toBe(1);
  expect(app.count("id:card-parent-badge")).toBe(1);
  expect(app.count("id:issue-tag-pill")).toBeGreaterThanOrEqual(3);

  // Clicking manual refresh triggers syncing feedback and invalidates issue queries.
  const historyCallsBefore = fake.calls.filter((c) => c.op === "issue.history.list").length;
  await app.press("id:issue-refresh");
  expect(app.count("id:issue-syncing")).toBe(1);
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.history.list").length > historyCallsBefore);

  // Scope toggle filters to Backlog (2) and Canceled (1).
  await app.press("id:issue-scope-backlog");
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 2);
  await app.press("id:issue-scope-canceled");
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 1);
  await app.press("id:issue-scope-all");
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 3);

  // Open child draft directly to verify TodoDetail inspector controls, EpochDatePicker, status picker, and trimmed triage actions.
  await app.host.send("route", `/issues/${childIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:todo-triage-actions") === 1);
  expect(app.count("id:todo-status")).toBe(1);
  expect(app.count("id:issue-parent-picker")).toBe(1);
  expect(app.count("id:issue-tag-editor")).toBe(1);
  expect(app.count("id:issue-start-at")).toBe(1);
  expect(app.count("id:issue-due-at")).toBe(1);
  expect(app.count("id:todo-mark-ready")).toBe(1);
  expect(app.count("id:issue-remove")).toBe(1);
  expect(app.count("id:todo-mark-done")).toBe(0);
  expect(app.count("id:todo-mark-canceled")).toBe(0);
  expect(app.count("id:todo-stage-pill")).toBe(0);
  expect(app.count("id:todo-review-banner")).toBe(0);

  // EpochDatePicker in inspector omits duplicate leading calendar icon (Property row already renders one).
  expect(app.count("id:issue-start-at-icon")).toBe(0);
  expect(app.count("id:issue-due-at-icon")).toBe(0);

  // Parent trail pill is constrained to max-w-64 and never overlaps #N pill.
  const parentTrailBox = app.layout("id:parent-issue");
  const copyIdBox = app.layout("id:issue-copy-id");
  expect(parentTrailBox).toBeDefined();
  expect(copyIdBox).toBeDefined();
  expect(parentTrailBox!.width).toBeLessThanOrEqual(256);
  if (Math.abs(parentTrailBox!.y - copyIdBox!.y) < Math.min(parentTrailBox!.height, copyIdBox!.height)) {
    expect(parentTrailBox!.x + parentTrailBox!.width).toBeLessThanOrEqual(copyIdBox!.x);
  }

  // EpochDatePicker in inspector picks a date preset (+3d) and commits via Save.
  await app.press("id:issue-start-at-trigger");
  await fake.pumpUntil(app, () => app.count("text:+3d") === 1);
  await app.press("text:+3d");
  await fake.pumpUntil(app, () => app.count("id:issue-save") === 1);
  await app.press("id:issue-save");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  const dateUpdate = fake.calls.findLast((c) => c.op === "issue.update");
  expect((dateUpdate?.payload as { startAt?: number } | undefined)?.startAt).toBeGreaterThan(0);

  // Completing via status picker updates status to done (closed) immediately.
  await app.press("id:todo-status-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("shared.status.done")}`) >= 1);
  await app.press(`text:${t("shared.status.done")}`);
  await fake.pumpUntil(app, () => app.count("id:todo-revive") === 1);
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.status.update"));
  const statusCall = fake.calls.find((c) => c.op === "issue.status.update");
  expect((statusCall?.payload as { status?: string } | undefined)?.status).toBe("done");

  // Open parent issue: sub-issues section with progress bar renders cleanly.
  await app.host.send("route", `/issues/${parentIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-sub-issues") === 1);
  expect(app.count("id:issue-sub-progress-bar")).toBe(1);
  expect(app.count("id:sub-issue-row")).toBe(1);
});

test("Issue DB-backed pickers (NewIssue repo/helper and ParentPicker) filter via search while fixed enums stay clean dropdowns", async () => {
  setLocale("zh");
  const parentOne = makeIssueFixture({
    id: "i-parent-alpha",
    number: 101,
    title: "Alpha Core Architecture",
    status: "todo",
    stage: { state: "draft", acts: [] },
  });
  const parentTwo = makeIssueFixture({
    id: "i-parent-beta",
    number: 102,
    title: "Beta Polish Pipeline",
    status: "todo",
    stage: { state: "draft", acts: [] },
  });
  const targetIssue = makeIssueFixture({
    id: "i-child-target",
    number: 103,
    title: "Child Picker Target",
    status: "backlog",
    stage: { state: "draft", acts: [] },
  });

  const state: SliceBundle = {
    ...scenarios.typical.state,
    board: { seq: 30, issues: [parentOne, parentTwo, targetIssue] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.history.list", [
    { issue: parentOne, sessions: [], missingSessions: [] },
    { issue: parentTwo, sessions: [], missingSessions: [] },
    { issue: targetIssue, sessions: [], missingSessions: [] },
  ]);
  fake.respond("issue.create", (payload: unknown) => {
    const p = payload as { title?: string; parent?: IssueId; startAt?: number };
    return makeIssueFixture({
      id: "i-created-child",
      number: 104,
      title: p.title ?? "Created child",
      status: "backlog",
      ...(p.parent ? { parent: p.parent } : {}),
      ...(p.startAt !== undefined ? { startAt: p.startAt } : {}),
      stage: { state: "draft", acts: [] },
    });
  });
  fake.respond("issue.refine", (payload: unknown) => {
    const p = payload as { id: string; text?: string };
    return makeIssueFixture({ id: p.id, number: 104, title: p.text ?? "Created child", status: "backlog", stage: { state: "draft", acts: [] } });
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-new") === 1);

  // NewIssue repo & helper pickers open downward and include searchable filtering.
  await app.press("id:issue-new");
  await fake.pumpUntil(app, () => app.count("id:issue-new-repo") === 1 && app.count("id:issue-new-helper") === 1);

  const repoTrigger = app.layout("id:issue-new-repo-trigger");
  expect(repoTrigger).toBeDefined();
  await app.press("id:issue-new-repo-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-new-repo-search") === 1);
  const repoSearch = app.layout("id:issue-new-repo-search");
  expect(repoSearch).toBeDefined();
  expect(repoSearch!.y).toBeGreaterThanOrEqual(repoTrigger!.y + repoTrigger!.height);
  await app.keyboard.press("escape");

  await app.press("id:issue-new-helper-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-new-helper-search") === 1);
  await app.type("id:issue-new-helper-search", "小林");
  await fake.pump(app);
  expect(app.texts()).toContain("小林");
  expect(app.texts()).not.toContain("老周");
  await app.keyboard.press("escape");

  // NewIssue searchable ParentPicker & EpochDatePicker wire parent + startAt into issue.create (standalone pickers retain leading icon).
  await fake.pumpUntil(app, () => app.count("id:issue-new-parent-trigger") === 1 && app.count("id:issue-new-start-at-trigger") === 1);
  expect(app.count("id:issue-new-start-at-icon")).toBe(1);
  expect(app.count("id:issue-new-due-at-icon")).toBe(1);
  await app.press("id:issue-new-parent-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-new-parent-search") === 1);
  await app.type("id:issue-new-parent-search", "Beta");
  await fake.pump(app);
  expect(app.texts()).toContain("#102 Beta Polish Pipeline");
  expect(app.texts()).not.toContain("#101 Alpha Core Architecture");
  await app.press("text:#102 Beta Polish Pipeline");

  await app.press("id:issue-new-start-at-trigger");
  await fake.pumpUntil(app, () => app.count("text:+3d") === 1);
  await app.press("text:+3d");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dates") === 1);

  await app.type("id:issue-new-text", "Child task from NewIssue");
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  const createdCall = fake.calls.findLast((c) => c.op === "issue.create");
  expect(createdCall?.payload).toMatchObject({
    title: "Child task from NewIssue",
    parent: "i-parent-beta",
  });
  expect((createdCall?.payload as { startAt?: number } | undefined)?.startAt).toBeGreaterThan(0);

  // TodoDetail: ParentPicker is searchable while status/priority/deliver remain non-searchable enum dropdowns.
  await app.host.send("route", `/issues/${targetIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-parent-picker") === 1);

  await app.press("id:todo-status-trigger");
  await fake.pump(app);
  expect(app.count("id:todo-status-search")).toBe(0);
  await app.keyboard.press("escape");

  await app.press("id:issue-priority-trigger");
  await fake.pump(app);
  expect(app.count("id:issue-priority-search")).toBe(0);
  await app.keyboard.press("escape");

  await app.press("id:issue-deliver-trigger");
  await fake.pump(app);
  expect(app.count("id:issue-deliver-search")).toBe(0);
  await app.keyboard.press("escape");

  await app.press("id:issue-parent-picker-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-parent-picker-search") === 1);
  await app.type("id:issue-parent-picker-search", "Beta");
  await fake.pump(app);
  expect(app.texts()).toContain("#102 Beta Polish Pipeline");
  expect(app.texts()).not.toContain("#101 Alpha Core Architecture");
});

test("Searchable OwnerPicker sets owner on NewIssue, TodoDetail, and IssueDetail without touching assignments", async () => {
  setLocale("zh");
  const targetIssue = makeIssueFixture({
    id: "i-owner-todo",
    number: 201,
    title: "Editable draft task for owner test",
    status: "todo",
    owner: { kind: "user", id: "self" },
    stage: { state: "draft", acts: [] },
  });
  const runningSession = makeFailedSession("s-owner-run", "Working on issue");
  const runningIssue = makeIssueFixture({
    id: "i-owner-running",
    number: 202,
    title: "Running task for owner delegation",
    status: "in_progress",
    owner: { kind: "user", id: "alice" },
    assignments: [
      {
        id: "a-run",
        issue: "i-owner-running" as IssueId,
        agent: "laozhou",
        assignedAt: SCENARIO_NOW - 1000,
        executions: [{ kind: "worker", session: runningSession.id, startedAt: SCENARIO_NOW - 1000 }],
      },
    ],
    stage: { state: "stuck", stuck: "failed", acts: [] },
  });
  const base = scenarios.typical;
  const state: SliceBundle = {
    ...base.state,
    board: { seq: 15, issues: [targetIssue, runningIssue] },
  };
  const fake = fakeHost({ state, responses: base.responses }, { route: "/issues", locale: "zh" });
  fake.respond("issue.create", (payload: unknown) => {
    const p = payload as { title?: string; owner?: Issue["owner"] };
    return makeIssueFixture({
      id: "i-owner-created",
      number: 203,
      title: p.title ?? "Owner test task",
      status: "backlog",
      ...(p.owner ? { owner: p.owner } : {}),
      stage: { state: "draft", acts: [] },
    });
  });
  fake.respond("issue.refine", (payload: unknown) => {
    const p = payload as { id: string; text?: string };
    return makeIssueFixture({
      id: p.id,
      number: 203,
      title: p.text ?? "Owner test task",
      status: "backlog",
      stage: { state: "draft", acts: [] },
    });
  });
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { id: string; owner?: Issue["owner"] };
    const existing = p.id === runningIssue.id ? runningIssue : targetIssue;
    return {
      ...existing,
      ...(p.owner ? { owner: p.owner } : {}),
      seq: 21,
    };
  });
  fake.respond("issue.history.list", [
    { issue: targetIssue, sessions: [], missingSessions: [] },
    { issue: runningIssue, sessions: [runningSession], missingSessions: [] },
  ]);

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 2);

  // 1. NewIssue: searchable OwnerPicker lists self, collaborators (alice/bob), and Expert agents (laozhou/xiaolin).
  await app.press("id:issue-toolbar-new");
  await fake.pumpUntil(app, () => app.count("id:issue-new-owner-trigger") === 1);
  await app.press("id:issue-new-owner-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-new-owner-search") === 1);
  await app.type("id:issue-new-owner-search", "老周");
  await fake.pumpUntil(app, () => app.count("text:老周") >= 1);
  expect(app.texts()).not.toContain("alice");
  await app.press("text:老周");
  await fake.pumpUntil(app, () => app.count("id:issue-new-owner-search") === 0);

  await app.type("id:issue-new-text", "Owner test task");
  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);
  const created = fake.calls.findLast((c) => c.op === "issue.create");
  expect(created?.payload).toMatchObject({
    title: "Owner test task",
    owner: { kind: "agent", id: "laozhou" },
  });

  // 2. TodoDetail: OwnerPicker updates owner to collaborator alice cleanly.
  await app.host.send("route", `/issues/${targetIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-owner-trigger") === 1);
  await app.press("id:issue-owner-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-owner-search") === 1);
  await app.type("id:issue-owner-search", "alice");
  await fake.pumpUntil(app, () => app.count("text:alice") >= 1);
  await app.press("text:alice");
  await fake.pumpUntil(app, () => app.count("id:issue-save") === 1);
  await app.press("id:issue-save");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  const todoOwnerUpd = fake.calls.findLast((c) => c.op === "issue.update");
  expect(todoOwnerUpd?.payload).toMatchObject({
    id: targetIssue.id,
    owner: { kind: "user", id: "alice" },
  });

  // 3. IssueDetail: OwnerPicker delegates running issue owner to Expert agent without changing execution assignments.
  await app.host.send("route", `/issues/${runningIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-owner-trigger") === 1);
  await app.press("id:issue-owner-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-owner-search") === 1);
  await app.type("id:issue-owner-search", "小林");
  await fake.pumpUntil(app, () => app.count("text:小林") >= 1);
  await app.press("text:小林");
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 2);
  const detailOwnerUpd = fake.calls.findLast((c) => c.op === "issue.update");
  expect(detailOwnerUpd?.payload).toMatchObject({
    id: runningIssue.id,
    owner: { kind: "agent", id: "xiaolin" },
  });
});

test("Group By renders collapsible groups across Kanban & List, and hierarchy modes fold children into clickable parent card rows", async () => {
  setLocale("zh");
  const parentOne = makeIssueFixture({
    id: "i-hier-parent-1",
    number: 301,
    title: "Parent epic A",
    status: "todo",
    priority: "urgent",
    owner: { kind: "user", id: "self" },
    stage: { state: "draft", acts: [] },
  });
  const childOne = makeIssueFixture({
    id: "i-hier-child-1",
    number: 302,
    title: "Child task A1",
    parent: "i-hier-parent-1" as IssueId,
    status: "in_progress",
    priority: "high",
    owner: { kind: "agent", id: "laozhou" },
    stage: { state: "draft", acts: [] },
  });
  const childTwo = makeIssueFixture({
    id: "i-hier-child-2",
    number: 303,
    title: "Child task A2",
    parent: "i-hier-parent-1" as IssueId,
    status: "done",
    priority: "medium",
    owner: { kind: "user", id: "alice" },
    stage: { state: "done", acts: [] },
  });
  const standalone = makeIssueFixture({
    id: "i-hier-solo",
    number: 304,
    title: "Standalone top-level task",
    status: "backlog",
    priority: "low",
    owner: { kind: "user", id: "self" },
    stage: { state: "draft", acts: [] },
  });

  const allIssues = [parentOne, childOne, childTwo, standalone];
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 20, issues: allIssues },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "zh" });
  fake.respond(
    "issue.history.list",
    allIssues.map((issue) => ({ issue, sessions: [], missingSessions: [] })),
  );

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 4);

  // Switch Group By -> Owner in Kanban board: creates collapsible owner swimlane groups with counts.
  await app.press("id:group-by-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.groupBy.owner")}`) === 1);
  await app.press(`text:${t("web.issue.groupBy.owner")}`);
  await fake.pumpUntil(app, () => app.count("id:issue-group-user:self") === 1);
  expect(app.count("id:issue-group-user:alice")).toBe(1);
  expect(app.count("id:issue-group-agent:laozhou")).toBe(1);
  expect(app.count("id:issue-group-body")).toBe(3);

  // Collapse the self owner group in Kanban.
  await app.press("id:issue-group-user:self");
  await fake.pumpUntil(app, () => app.count("id:issue-group-body") === 2);

  // Switch to List view & Group By -> Priority; verify 4 priority groups and collapsible toggle.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:issue-list") === 1);
  await app.press("id:group-by-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.groupBy.priority")}`) === 1);
  await app.press(`text:${t("web.issue.groupBy.priority")}`);
  await fake.pumpUntil(app, () => app.count("id:issue-group-urgent") === 1);
  expect(app.count("id:issue-group-high")).toBe(1);
  expect(app.count("id:issue-group-medium")).toBe(1);
  expect(app.count("id:issue-group-low")).toBe(1);

  // Reset Group By -> None and switch back to Kanban for hierarchy verification.
  await app.press("id:group-by-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.groupBy.none")}`) === 1);
  await app.press(`text:${t("web.issue.groupBy.none")}`);
  await app.press("id:issue-view-board");
  await fake.pumpUntil(app, () => app.count("id:issue-board") === 1);

  // Switch Hierarchy -> top_level: child cards disappear from outer board, leaving parentOne + standalone (2 outer cards).
  await app.press("id:hierarchy-mode-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.hierarchy.top_level")}`) === 1);
  await app.press(`text:${t("web.issue.hierarchy.top_level")}`);
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 2);
  expect(app.count("id:card-children")).toBe(1);
  expect(app.count("id:card-child-i-hier-child-1")).toBe(1);
  expect(app.count("id:card-child-i-hier-child-2")).toBe(1);
  expect(app.texts()).toContain("1/2");

  // Switch Hierarchy -> parents_only: only parentOne remains as outer card (1 outer card), with children still inside.
  await app.press("id:hierarchy-mode-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.hierarchy.parents_only")}`) === 1);
  await app.press(`text:${t("web.issue.hierarchy.parents_only")}`);
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 1);
  expect(app.count("id:card-child-i-hier-child-1")).toBe(1);

  // Clicking a compact child row directly opens that child's Quick-Peek modal (not the parent).
  await app.press("id:card-child-i-hier-child-1");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.texts()).toContain("#301 Parent epic A");
  expect(app.texts()).toContain("Child task A1");
});

test("BlockedByPicker edits blockedBy with cycle-safe options and clickable Blocked-by chips navigate across Board, List, and Timeline", async () => {
  setLocale("en");
  const dayStart = Date.UTC(2026, 10, 20);
  const blockerA = makeIssueFixture({
    id: "i-dep-a",
    number: 401,
    title: "Core API contract",
    status: "todo",
    startAt: dayStart,
    dueAt: dayStart + 86_400_000,
    stage: { state: "draft", acts: [] },
  });
  const blockedB = makeIssueFixture({
    id: "i-dep-b",
    number: 402,
    title: "UI integration task",
    status: "backlog",
    blockedBy: ["i-dep-a" as IssueId],
    startAt: dayStart + 86_400_000,
    dueAt: dayStart + 2 * 86_400_000,
    stage: { state: "draft", acts: [] },
  });
  const candidateC = makeIssueFixture({
    id: "i-dep-c",
    number: 403,
    title: "Telemetry verifier",
    status: "in_progress",
    assignments: [
      {
        id: "assign-dep-c",
        issue: "i-dep-c" as IssueId,
        agent: "laozhou",
        assignedAt: SCENARIO_NOW - 10_000,
        executions: [{ kind: "worker", session: "s-dep-c" as SessionId, startedAt: SCENARIO_NOW - 10_000 }],
      },
    ],
    stage: { state: "working", acts: [] },
  });
  const depSession = makeFailedSession("s-dep-c", "Running telemetry");

  const spanA = {
    startMs: dayStart,
    endMs: dayStart + 86_400_000,
    durationDays: 2,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  const spanB = {
    startMs: dayStart + 86_400_000,
    endMs: dayStart + 2 * 86_400_000,
    durationDays: 2,
    hasExplicitStart: true,
    hasExplicitDue: true,
    rolledUp: false,
    overdue: false,
  };
  let issuesState = [blockerA, blockedB, candidateC];
  let seq = 30;
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: {
      seq,
      issues: issuesState,
      boardSummary: {
        laneCounts: { backlog: 1, todo: 1, inProgress: 1, inReview: 0, done: 0, canceled: 0 },
        runningSlots: 0,
        maxRunning: 3,
        byIssue: {
          [blockerA.id]: { lane: "todo", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: spanA },
          [blockedB.id]: { lane: "backlog", cardKind: "todo", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false, schedule: spanB },
          [candidateC.id]: { lane: "in_progress", cardKind: "issue", familyDone: 0, familyTotal: 0, needsWorktreeCheck: false },
        },
        schedule: {
          todayDayMs: dayStart,
          scheduled: [
            { issueId: blockerA.id, span: spanA, depth: 0, isParent: false, childCount: 0 },
            { issueId: blockedB.id, span: spanB, depth: 0, isParent: false, childCount: 0 },
          ],
          unscheduledIds: [candidateC.id],
        },
      },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "en" });
  fake.respond("issue.history.list", () =>
    issuesState.map((issue) => ({
      issue,
      sessions: issue.id === candidateC.id ? [depSession] : [],
      missingSessions: [],
    })),
  );
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { id: string; blockedBy?: string[] };
    issuesState = issuesState.map((item) =>
      item.id === p.id
        ? {
            ...item,
            ...(p.blockedBy !== undefined ? { blockedBy: p.blockedBy.map((id) => id as IssueId) } : {}),
          }
        : item,
    );
    const updated = issuesState.find((i) => i.id === p.id)!;
    return { ...updated, seq: ++seq };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:card-blocked-by-i-dep-a") === 1);

  // 1. Kanban Board renders clickable "Blocked by #401" chip; clicking it peeks #401 (not #402).
  expect(app.shows("id:card-blocked-by-i-dep-a >> text:Blocked by #401")).toBe(true);
  await app.press("id:card-blocked-by-i-dep-a");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.texts()).toContain("Core API contract");
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // 2. List view renders clickable "Blocked by #401" chip; clicking it peeks #401.
  await app.press("id:issue-view-list");
  await fake.pumpUntil(app, () => app.count("id:row-blocked-by-i-dep-a") === 1);
  await app.press("id:row-blocked-by-i-dep-a");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.texts()).toContain("Core API contract");
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // 3. Timeline view renders clickable "Blocked by #401" chip; clicking it peeks #401.
  await app.press("id:issue-view-timeline");
  await fake.pumpUntil(app, () => app.count("id:timeline-blocked-by-i-dep-a") === 1);
  await app.press("id:timeline-blocked-by-i-dep-a");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.texts()).toContain("Core API contract");
  await app.press("id:issue-peek-close");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // 4. TodoDetail: BlockedByPicker excludes self and cycle-forming B (#402) on A (#401), and adds #403 to B (#402).
  await app.host.send("route", `/issues/${blockerA.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-blocked-by-picker-trigger") === 1);
  await app.press("id:issue-blocked-by-picker-trigger");
  await fake.pumpUntil(app, () => app.count("text:#403 Telemetry verifier") === 1);
  expect(app.count("text:#402 UI integration task")).toBe(0);
  await app.keyboard.press("escape");

  await app.host.send("route", `/issues/${blockedB.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-blocked-by-picker-trigger") === 1);
  await app.type("id:issue-blocked-by-picker-input", "Telemetry");
  await fake.pumpUntil(app, () => app.count("text:#403 Telemetry verifier") === 1);
  await app.press("text:#403 Telemetry verifier");
  await fake.pumpUntil(app, () => app.count("id:issue-save") === 1);
  await app.press("id:issue-save");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  const todoUpd = fake.calls.findLast((c) => c.op === "issue.update");
  expect(todoUpd?.payload).toMatchObject({
    id: blockedB.id,
    blockedBy: [blockerA.id, candidateC.id],
  });

  // 5. IssueDetail (running issue): BlockedByPicker updates blockedBy immediately via intent.
  await app.host.send("route", `/issues/${candidateC.id}`);
  await fake.pumpUntil(app, () => app.count("id:issue-blocked-by-picker-trigger") === 1);
  await app.press("id:issue-blocked-by-picker-trigger");
  await fake.pumpUntil(app, () => app.count("text:#401 Core API contract") === 1);
  await app.press("text:#401 Core API contract");
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length >= 2);
  const detailUpd = fake.calls.findLast((c) => c.op === "issue.update");
  expect(detailUpd?.payload).toMatchObject({
    id: candidateC.id,
    blockedBy: [blockerA.id],
  });
});

test("Keyboard j/k/Enter/e navigation, x/Shift+click multi-select, and BatchTriageBar compose with Group By and Hierarchy", async () => {
  setLocale("en");
  const t1 = makeIssueFixture({
    id: "i-kbd-1",
    number: 501,
    title: "First backlog item",
    status: "backlog",
    moves: ["todo", "in_progress", "in_review", "done", "canceled"],
    priority: "medium",
    stage: { state: "draft", acts: [] },
  });
  const t2 = makeIssueFixture({
    id: "i-kbd-2",
    number: 502,
    title: "Second todo item",
    status: "todo",
    moves: ["backlog", "in_progress", "in_review", "done", "canceled"],
    priority: "high",
    stage: { state: "draft", acts: [] },
  });
  const t3 = makeIssueFixture({
    id: "i-kbd-3",
    number: 503,
    title: "Third review item",
    status: "in_review",
    moves: ["backlog", "todo", "in_progress", "done", "canceled"],
    priority: "low",
    stage: { state: "reviewing", acts: [] },
  });
  const childHidden = makeIssueFixture({
    id: "i-kbd-child",
    number: 504,
    title: "Hidden child in top_level mode",
    parent: t2.id,
    status: "todo",
    moves: ["backlog", "in_progress", "done", "canceled"],
    priority: "urgent",
    stage: { state: "draft", acts: [] },
  });

  const all = [t1, t2, t3, childHidden];
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 40, issues: all },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: "/issues", locale: "en" });
  fake.respond(
    "issue.history.list",
    all.map((issue) => ({ issue, sessions: [], missingSessions: [] })),
  );
  fake.respond("issue.update", (payload: unknown) => {
    const p = payload as { id: string };
    const found = all.find((i) => i.id === p.id)!;
    return { ...found, seq: 41 };
  });
  fake.respond("issue.status.update", (payload: unknown) => {
    const p = payload as { id: string; status: Issue["status"] };
    const found = all.find((i) => i.id === p.id)!;
    return { ...found, status: p.status, seq: 42 };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 4);

  // Compose with Hierarchy -> top_level (hides i-kbd-child, leaving 3 top-level cards: 501, 502, 503).
  await app.press("id:hierarchy-mode-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("web.issue.hierarchy.top_level")}`) === 1);
  await app.press(`text:${t("web.issue.hierarchy.top_level")}`);
  await fake.pumpUntil(app, () => app.count("id:issue-card") === 3);

  // j moves focus to first item (#501), j again to #502, Enter opens Quick-Peek for #502.
  await app.keyboard.press("j");
  await app.keyboard.press("j");
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1);
  expect(app.texts()).toContain("Second todo item");
  await app.back();
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 0);

  // k moves focus back to #501; e opens full Issue detail page for #501, Escape returns to board.
  await app.keyboard.press("k");
  await app.keyboard.press("e");
  await fake.pumpUntil(app, () => app.count("id:issue") === 1);
  expect(app.texts()).toContain("First backlog item");
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => app.count("id:issue-board") === 1);

  // x toggles selection on #501 and opens floating BatchTriageBar ("1 selected").
  await app.keyboard.press("x");
  await fake.pumpUntil(app, () => app.count("id:batch-triage-bar") === 1);
  expect(app.shows("id:batch-triage-count >> text:1 selected")).toBe(true);

  // Shift+click on #503 selects range (#501, #502, #503 -> 3 selected, excluding hidden child).
  await app.keyboard.down("shift");
  await app.press("text:Third review item");
  await app.keyboard.up("shift");
  await fake.pumpUntil(app, () => app.shows("id:batch-triage-count >> text:3 selected"));

  // Batch update priority -> urgent (fires issue.update for all 3 selected issues).
  await app.press("id:batch-triage-priority-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("shared.priority.urgent")}`) >= 1);
  await app.press(`text:${t("shared.priority.urgent")}`);
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length === 3);
  expect(fake.calls.filter((c) => c.op === "issue.update").map((c) => c.payload)).toEqual([
    { id: t1.id, priority: "urgent" },
    { id: t2.id, priority: "urgent" },
    { id: t3.id, priority: "urgent" },
  ]);

  // Batch update status -> done (skips nothing since none are done, fires 3 issue.status.update calls).
  await app.press("id:batch-triage-status-trigger");
  await fake.pumpUntil(app, () => app.count(`text:${t("shared.status.done")}`) >= 1);
  await app.press(`text:${t("shared.status.done")}`);
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.status.update").length === 3);

  // Batch add tag ("UX") via tags popover.
  await app.press("id:batch-triage-tags-trigger");
  await fake.pumpUntil(app, () => app.count("id:batch-triage-tags-popover") === 1);
  await app.press("id:tag-preset-UX");
  await app.press("id:batch-triage-tags-add");
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "issue.update").length === 6);

  // Clear selection closes the floating BatchTriageBar.
  await app.press("id:batch-triage-clear");
  await fake.pumpUntil(app, () => app.count("id:batch-triage-bar") === 0);
});

test("Issue detail displays and updates non-blocking relations without blocking status", async () => {
  setLocale("en");
  const primary = makeIssueFixture({
    id: "i-rel-1",
    number: 601,
    title: "Primary API endpoint",
    status: "backlog",
    relations: [{ kind: "related", issue: issueId("i-rel-2") }],
    stage: { state: "draft", acts: [] },
  });
  const peer = makeIssueFixture({
    id: "i-rel-2",
    number: 602,
    title: "Related schema update",
    status: "backlog",
    relations: [{ kind: "related", issue: issueId("i-rel-1") }],
    stage: { state: "draft", acts: [] },
  });
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 50, issues: [primary, peer] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${primary.id}`, locale: "en" });
  fake.respond("issue.history.list", [
    { issue: primary, sessions: [], missingSessions: [] },
    { issue: peer, sessions: [], missingSessions: [] },
  ]);
  fake.respond("issue.update", (payload: unknown) => ({
    ...primary,
    ...(payload as Record<string, unknown>),
    seq: 51,
  }));

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:issue-relations-picker") === 1 && app.count("id:detail-relations") === 1);
  expect(app.texts()).toContain("Related #602");

  // Clear relations via picker clear button and Save.
  await app.press("id:issue-relations-picker-clear");
  await fake.pumpUntil(app, () => app.count("id:issue-save") === 1);
  await app.press("id:issue-save");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.update"));
  expect(fake.calls.find((c) => c.op === "issue.update")?.payload).toMatchObject({
    id: primary.id,
    relations: [],
  });
});
