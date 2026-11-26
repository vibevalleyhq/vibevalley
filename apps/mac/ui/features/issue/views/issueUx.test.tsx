import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Issue, IssueId, Session, SessionId, SliceBundle } from "@vibevalley/protocol";

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
  fake.respond("issue.timeline", {
    milestones: [
      { at: SCENARIO_NOW - 60_000, kind: "failed", who: "老周", text: "失败：no API key is set for the model" },
      { at: SCENARIO_NOW - 600_000, kind: "opened", text: "开了这个工单" },
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
    board: { seq: 15, issues: [compareIssue, imageIssue] },
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

  // Clicking a card opens Quick-Peek modal with preview-first Compare content, dismissible via Close, or expandable to full screen.
  await app.press("id:issue-card >> nth=0");
  await fake.pumpUntil(app, () => app.count("id:issue-peek-modal") === 1 && app.count("id:compare-card") === 1);
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
  fake.respond("issue.status.update", (payload: unknown) => {
    const p = payload as { id: string; status: Issue["status"] };
    return { ...childIssue, id: p.id as IssueId, status: p.status, seq: 21 };
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

  // Open child draft directly to verify TodoDetail inspector controls, interactive status picker, and one-click triage actions.
  await app.host.send("route", `/issues/${childIssue.id}`);
  await fake.pumpUntil(app, () => app.count("id:todo-triage-actions") === 1);
  expect(app.count("id:todo-status")).toBe(1);
  expect(app.count("id:issue-parent-picker")).toBe(1);
  expect(app.count("id:issue-tag-editor")).toBe(1);
  expect(app.count("id:issue-start-at")).toBe(1);
  expect(app.count("id:issue-due-at")).toBe(1);
  expect(app.count("id:todo-mark-ready")).toBe(1);
  expect(app.count("id:todo-mark-done")).toBe(1);
  expect(app.count("id:todo-mark-canceled")).toBe(1);

  // Even when a draft field is edited locally, marking done optimistically updates status to done (closed) immediately.
  await app.press("id:issue-title-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-title-input") === 1);
  await app.type("id:issue-title-input", " draft edit");
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => app.count("id:issue-save") === 1);

  await app.press("id:todo-mark-done");
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
  await app.press("id:issue-new-dialog-never");
  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 0);

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
