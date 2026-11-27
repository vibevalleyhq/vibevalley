import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type {
  Channel,
  ChatMessage,
  Issue,
  IssueId,
  MessageId,
  Milestone,
  Note,
  NoteId,
  Run,
  Session,
  SessionEvent,
  SessionId,
  SliceBundle,
} from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

function makeIssue(overrides: Partial<Omit<Issue, "id">> & { id: string; number: number; title: string }): Issue {
  return {
    description: "Unified issue activity stream test.",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "in_review",
    moves: ["todo", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: ["Chronological stream merges milestones, comments, and run steps"],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 600_000,
    stage: { state: "reviewing", acts: [{ act: "complete", does: "move", status: "done", words: "none" }], lead: "complete" },
    ...overrides,
    id: overrides.id as IssueId,
  };
}

function makeSession(id: string): Session {
  return {
    id: id as SessionId,
    controller: "issueBoard",
    role: "worker",
    name: "Helper",
    profile: "helper",
    runtime: "vibevalley",
    policy: { kind: "sandboxDir" },
    bindings: [],
    phase: { _tag: "resting" },
    hiredAt: SCENARIO_NOW - 500_000,
    brief: "Fix login",
    runs: 1,
    lastRun: { outcome: "completed", summary: "Fixed redirect", at: SCENARIO_NOW - 200_000 },
  };
}

function makeChannel(issueId: string, channelId: string): Channel {
  return {
    id: channelId,
    name: "#91",
    title: "Unified stream",
    description: "",
    category: "issues",
    type: "thread",
    default: false,
    notify: "all",
    replies: 0,
    at: SCENARIO_NOW - 550_000,
    subjectKind: "issue",
    subjectId: issueId,
    members: [],
  };
}

function makeMessage(overrides: Partial<Omit<ChatMessage, "id">> & { id: string; channel: string; number: number; at: number; text: string }): ChatMessage {
  return {
    from: "user",
    name: "User",
    actor: { kind: "user", id: "user" },
    kind: "chat",
    outcome: null,
    spoken: false,
    revision: 1,
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    ...overrides,
    id: overrides.id as MessageId,
  };
}

test("IssueDetail merges milestones, discussion messages, and expandable per-run steps in chronological order without duplicate Runs fold", async () => {
  setLocale("en");
  const session = makeSession("s-act-1");
  const issue = makeIssue({
    id: "i-act-1",
    number: 91,
    title: "Unify issue activity stream",
    assignments: [
      {
        id: "assign-1",
        issue: "i-act-1" as IssueId,
        agent: "helper",
        assignedAt: SCENARIO_NOW - 500_000,
        executions: [{ kind: "worker", session: session.id, startedAt: SCENARIO_NOW - 500_000 }],
      },
    ],
  });
  const channel = makeChannel(issue.id, "ch-act-1");
  const milestones: Milestone[] = [
    { at: SCENARIO_NOW - 600_000, kind: "opened", text: "Opened" },
    { at: SCENARIO_NOW - 500_000, kind: "started", who: "Helper", text: "Started", run: "r1" },
    { at: SCENARIO_NOW - 200_000, kind: "reported", who: "Helper", text: "Handed back", said: "Implemented unified stream", run: "r1" },
  ];
  const messages: ChatMessage[] = [
    makeMessage({ id: "m-early", channel: channel.id, number: 1, at: SCENARIO_NOW - 400_000, text: "Check edge cases while working" }),
    makeMessage({ id: "m-late", channel: channel.id, number: 2, at: SCENARIO_NOW - 100_000, text: "Looks great after handback" }),
  ];
  const runs: Run[] = [
    {
      needsReconciliation: false,
      id: "r1",
      session: session.id,
      issue: issue.id,
      triggeredBy: { kind: "issue" },
      heard: [],
      startedAt: SCENARIO_NOW - 500_000,
      endedAt: SCENARIO_NOW - 200_000,
      outcome: "completed",
      summary: "Implemented unified stream",
      spent: { tokens: 1200, cny: 0.12 },
    },
  ];
  const events: SessionEvent[] = [
    { seq: 1, revision: 1, time: SCENARIO_NOW - 490_000, type: "run/start", run: "r1", text: "" },
    {
      seq: 2,
      revision: 1,
      time: SCENARIO_NOW - 450_000,
      type: "tool/call",
      run: "r1",
      action: "read_file",
      tool: "read",
      input: "IssueDetail.tsx",
      actionText: "Read IssueDetail.tsx",
      text: "",
    },
    { seq: 3, revision: 1, time: SCENARIO_NOW - 440_000, type: "tool/result", run: "r1", call: 2, output: "ok", ok: true, text: "" },
    { seq: 4, revision: 1, time: SCENARIO_NOW - 210_000, type: "assistant/message", run: "r1", text: "Implemented unified stream" },
    { seq: 5, revision: 1, time: SCENARIO_NOW - 200_000, type: "run/end", run: "r1", text: "" },
  ];

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 1, issues: [issue] },
    collab: {
      ...scenarios.empty.state.collab,
      chat: { channels: [channel], userMentions: [] },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${issue.id}`, locale: "en" });
  fake.respond("issue.history.list", [{ issue, sessions: [session], missingSessions: [] }]);
  fake.respond("issue.timeline.get", { milestones, spent: { tokens: 1200, cny: 0.12 } });
  fake.respond("issue.run.list", runs);
  fake.respond("issue.conversation.get", channel.id);
  fake.respond("channel.message.list", messages);
  const shownEvents1: SessionEvent[] = [{ ...events[1], output: "ok", ok: true }, events[3]];
  fake.respond("session.event.list", {
    events,
    hasMore: false,
    oldestSeq: 1,
    newestSeq: 5,
    trajectory: {
      shown: shownEvents1,
      runs: [{ run: "r1", steps: shownEvents1 }],
      waterfall: { runs: [], spans: [] },
      summary: { runs: 1, steps: 2, modelMs: 0, toolMs: 10_000, input: 0, cacheRead: 0, output: 0 },
      stepDurations: [
        { seq: 2, durationMs: 10_000 },
        { seq: 4, durationMs: 0 },
      ],
      stepMeta: [
        { seq: 2, durationMs: 10_000, readableInput: "IssueDetail.tsx" },
        { seq: 4, durationMs: 0 },
      ],
      telemetry: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, llmRetries: 0, runErrors: 0 },
    },
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(
    app,
    () => app.count("id:issue-activity") === 1 && app.count("id:milestone") === 3 && app.count("id:issue-message") === 2 && app.count("id:run-steps") === 1,
  );

  // Old duplicate sections are retired.
  expect(app.count("id:issue-story")).toBe(0);
  expect(app.count("id:issue-runs-fold")).toBe(0);
  expect(app.count("id:issue-steps-fold")).toBe(0);
  expect(app.count("id:issue-conversation")).toBe(0);

  // Chronological vertical layout: Opened -> Started -> m-early -> Reported -> m-late.
  const openedBox = app.layout("id:milestone >> nth=0")!;
  const startedBox = app.layout("id:milestone >> nth=1")!;
  const earlyMsgBox = app.layout("id:issue-message >> nth=0")!;
  const reportedBox = app.layout("id:milestone >> nth=2")!;
  const lateMsgBox = app.layout("id:issue-message >> nth=1")!;
  expect(openedBox.y).toBeLessThan(startedBox.y);
  expect(startedBox.y).toBeLessThan(earlyMsgBox.y);
  expect(earlyMsgBox.y).toBeLessThan(reportedBox.y);
  expect(reportedBox.y).toBeLessThan(lateMsgBox.y);

  // Separated `said` summary renders cleanly on the milestone, and expandable per-run steps open WorkLog.
  expect(app.count("id:milestone-said")).toBe(1);
  expect(app.texts()).toContain("Implemented unified stream");
  expect(app.count("id:work-log")).toBe(0);
  await app.press("id:run-steps");
  await fake.pumpUntil(app, () => app.count("id:work-log") === 1);
  expect(app.texts().join("\n")).toContain("Read IssueDetail.tsx");
});

test("TodoDetail renders unified issue-activity stream with milestones, comments, and active run steps", async () => {
  setLocale("en");
  const todo = makeIssue({
    id: "i-todo-act",
    number: 92,
    title: "Draft with unified activity",
    status: "backlog",
    stage: { state: "draft", acts: [] },
  });
  const channel = makeChannel(todo.id, "ch-todo-92");
  const milestones: Milestone[] = [
    { at: SCENARIO_NOW - 300_000, kind: "opened", text: "Opened" },
    { at: SCENARIO_NOW - 120_000, kind: "started", who: "Helper", text: "Started drafting", run: "r-draft" },
  ];
  const messages: ChatMessage[] = [makeMessage({ id: "m-todo", channel: channel.id, number: 1, at: SCENARIO_NOW - 200_000, text: "Draft note from user" })];
  const runs: Run[] = [
    {
      needsReconciliation: false,
      id: "r-draft",
      session: "s-draft" as SessionId,
      issue: todo.id,
      triggeredBy: { kind: "refine" },
      heard: [],
      startedAt: SCENARIO_NOW - 120_000,
      summary: "",
    },
  ];
  const events: SessionEvent[] = [
    { seq: 1, revision: 1, time: SCENARIO_NOW - 115_000, type: "run/start", run: "r-draft", text: "" },
    {
      seq: 2,
      revision: 1,
      time: SCENARIO_NOW - 110_000,
      type: "tool/call",
      run: "r-draft",
      action: "search",
      tool: "grep",
      input: "TodoDetail",
      actionText: "Search TodoDetail",
      text: "",
    },
  ];

  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 1, issues: [todo] },
    collab: {
      ...scenarios.empty.state.collab,
      chat: { channels: [channel], userMentions: [] },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${todo.id}`, locale: "en" });
  fake.respond("issue.timeline.get", { milestones });
  fake.respond("issue.run.list", runs);
  fake.respond("issue.conversation.get", channel.id);
  fake.respond("channel.message.list", messages);
  fake.respond("session.event.list", {
    events,
    hasMore: false,
    oldestSeq: 1,
    newestSeq: 2,
    trajectory: {
      shown: [events[1]],
      runs: [{ run: "r-draft", steps: [events[1]] }],
      waterfall: { runs: [], spans: [] },
      summary: { runs: 1, steps: 1, modelMs: 0, toolMs: 0, input: 0, cacheRead: 0, output: 0 },
      stepDurations: [{ seq: 2, durationMs: 0 }],
      stepMeta: [{ seq: 2, durationMs: 0, readableInput: "TodoDetail" }],
      telemetry: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, llmRetries: 0, runErrors: 0 },
    },
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(
    app,
    () =>
      app.count("id:issue-activity") === 1 &&
      app.count("id:milestone") === 2 &&
      app.count("id:issue-message") === 1 &&
      app.count("id:run-steps") === 1 &&
      app.count("id:issue-comment-composer") === 1,
  );

  expect(app.texts()).toContain(t("web.issue.activity.title"));
  expect(app.texts()).toContain("Draft note from user");
  await app.press("id:run-steps");
  await fake.pumpUntil(app, () => app.count("id:work-log") === 1);
  expect(app.texts().join("\n")).toContain("Search TodoDetail");
});

test("IssueActivity renders fallback comment composer before a thread channel exists and resolves [[note:...]] links in comments", async () => {
  setLocale("en");
  const todo = makeIssue({
    id: "i-fallback-comment",
    number: 93,
    title: "Pre-dispatch comment and note links",
    status: "backlog",
    stage: { state: "draft", acts: [] },
  });
  const linkedNote: Note = {
    id: "note-arch-93" as NoteId,
    title: "Architecture Spec",
    noteType: "doc",
    seq: 1,
    version: 1,
    versions: [],
    by: "user",
    byName: "User",
    at: SCENARIO_NOW - 10_000,
    updated: SCENARIO_NOW - 1_000,
    sortOrder: 0,
  };
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 1, issues: [todo] },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${todo.id}`, locale: "en" });
  fake.respond("note.list", () => [linkedNote]);
  fake.respond("issue.conversation.get", () => null);
  fake.respond("issue.comment.create", () => ({ seq: 1 }));
  fake.respond("issue.timeline.get", { milestones: [] });
  fake.respond("issue.run.list", []);

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 950,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-comment-fallback-composer") === 1);
  expect(app.count("id:issue-comment-composer")).toBe(0);

  await app.type("id:issue-comment-fallback-input", "See [[note:note-arch-93]] before implementing");
  await app.press("id:issue-comment-fallback-send");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "issue.comment.create"));
  const sent = fake.calls.find((c) => c.op === "issue.comment.create");
  expect(sent?.payload).toMatchObject({ id: todo.id, text: "See [[note:note-arch-93]] before implementing" });

  // Switch to active thread channel with a comment containing [[note:...]] and verify NoteLinkPills render.
  const channel = makeChannel(todo.id, "ch-93");
  const msgWithNote = makeMessage({
    id: "m-note-ref",
    channel: channel.id,
    number: 1,
    at: SCENARIO_NOW - 5_000,
    text: "Updated [[note:note-arch-93]] notes.",
  });
  fake.respond("issue.conversation.get", () => channel.id);
  fake.respond("channel.message.list", () => [msgWithNote]);
  await fake.setSlice(app, "collab", {
    ...scenarios.empty.state.collab,
    chat: { channels: [channel], userMentions: [] },
  });
  await fake.pumpUntil(app, () => app.count("id:issue-note-link-note-arch-93") === 1);
});
