import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Attachment, Channel, ChatMessage, Issue, IssueId, MessageId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

function makeIssue(id: string, number: number): Issue {
  return {
    id: id as IssueId,
    number,
    title: "Render comment attachments on issue thread",
    description: "Issue thread should render media and file attachments.",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "todo",
    moves: ["in_progress", "done", "canceled"],
    priority: "medium",
    deliver: "change",
    criteria: ["Images open Lightbox"],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: SCENARIO_NOW - 600_000,
    stage: { state: "draft", acts: [] },
  };
}

function makeThreadChannel(issueId: string, channelId: string): Channel {
  return {
    id: channelId,
    name: "#86",
    title: "Render comment attachments on issue thread",
    description: "",
    category: "issues",
    type: "thread",
    default: false,
    notify: "all",
    replies: 0,
    at: SCENARIO_NOW - 300_000,
    subjectKind: "issue",
    subjectId: issueId,
    members: [],
  };
}

function makeComment(
  overrides: Partial<Omit<ChatMessage, "id">> & { id: string; channel: string; number: number; text: string; attachments?: Attachment[] },
): ChatMessage {
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
    at: SCENARIO_NOW - 60_000,
    ...overrides,
    id: overrides.id as MessageId,
  };
}

async function mountIssueThread(messages: ChatMessage[]) {
  setLocale("en");
  const issue = makeIssue("i-thread-att", 86);
  const channel = makeThreadChannel(issue.id, "ch-issue-86");
  const state: SliceBundle = {
    ...scenarios.empty.state,
    board: { seq: 1, issues: [issue] },
    collab: {
      ...scenarios.empty.state.collab,
      chat: {
        channels: [channel],
        userMentions: [],
      },
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${issue.id}`, locale: "en" });
  fake.respond("issue.history.list", [{ issue, sessions: [], missingSessions: [] }]);
  fake.respond("issue.conversation.get", channel.id);
  fake.respond("channel.message.list", messages);
  fake.respond("attachment.file", (payload: unknown) => {
    const id = (payload as { id?: string } | undefined)?.id ?? "unknown";
    if (id === "att-video") return { path: "/tmp/demo.mp4", type: "video/mp4", name: "demo.mp4" };
    if (id === "att-audio") return { path: "/tmp/note.mp3", type: "audio/mpeg", name: "note.mp3" };
    if (id === "att-pdf") return { path: "/tmp/spec.pdf", type: "application/pdf", name: "spec.pdf" };
    return { path: `/tmp/${id}.png`, type: "image/png", name: `${id}.png` };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-message") === messages.length);
  return { app, fake };
}

test("IssueThread renders image thumbnails, video/audio/file attachments, and opens Lightbox on image click", async () => {
  const comments: ChatMessage[] = [
    makeComment({
      id: "m-media",
      channel: "ch-issue-86",
      number: 1,
      text: "Check the screenshot and media files.",
      attachments: [
        { id: "att-img", name: "screenshot.png", type: "image/png", size: 4096 },
        { id: "att-video", name: "demo.mp4", type: "video/mp4", size: 8192 },
        { id: "att-audio", name: "note.mp3", type: "audio/mpeg", size: 2048 },
        { id: "att-pdf", name: "spec.pdf", type: "application/pdf", size: 1024 },
      ],
    }),
  ];

  const { app, fake } = await mountIssueThread(comments);
  await fake.pumpUntil(app, () => fake.calls.filter((c) => c.op === "attachment.file").length >= 4);
  await fake.pump(app);

  expect(app.count("id:issue-message >> id:issue-message-body")).toBe(1);
  expect(app.count("id:issue-message >> id:attachment-screenshot.png")).toBe(1);
  expect(app.count("id:issue-message >> id:attachment-demo.mp4")).toBe(1);
  expect(app.count("id:issue-message >> id:attachment-note.mp3")).toBe(1);
  expect(app.count("id:issue-message >> id:attachment-note.mp3 >> id:attachment-play")).toBe(1);
  expect(app.count("id:issue-message >> id:attachment-spec.pdf")).toBe(1);

  expect(app.count("id:lightbox")).toBe(0);
  await app.press("id:attachment-screenshot.png");
  expect(app.count("id:lightbox")).toBe(1);
  expect(app.count("id:lightbox-name")).toBe(1);
  expect(app.shows("id:lightbox >> text:screenshot.png")).toBe(true);

  await app.press("id:lightbox-close");
  expect(app.count("id:lightbox")).toBe(0);
});

test("IssueThread omits Markdown box on attachment-only comments", async () => {
  const comments: ChatMessage[] = [
    makeComment({
      id: "m-only-att",
      channel: "ch-issue-86",
      number: 1,
      text: "   \n ",
      attachments: [{ id: "att-only", name: "only-image.png", type: "image/png", size: 1024 }],
    }),
  ];

  const { app, fake } = await mountIssueThread(comments);
  await fake.pumpUntil(app, () => app.count("id:issue-message >> id:attachment-only-image.png") === 1);

  expect(app.count("id:issue-message")).toBe(1);
  expect(app.count("id:issue-message >> id:issue-message-body")).toBe(0);
  expect(app.count("id:issue-message >> id:attachment-only-image.png")).toBe(1);
});
