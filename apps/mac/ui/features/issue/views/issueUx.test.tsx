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

  // Todo group has 2 issues; working/waiting/closed are empty (0 rows) and render no group body.
  expect(app.count("id:issue-group")).toBeGreaterThanOrEqual(3);
  expect(app.count("id:issue-group-body")).toBe(1);
  expect(app.count("id:issue-group-todo")).toBe(1);
  expect(app.count("id:issue-group-working")).toBe(1);
  expect(app.count("id:issue-group-waiting")).toBe(1);
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
