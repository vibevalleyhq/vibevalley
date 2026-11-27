import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Channel, type ChatMessage, type Issue, type Note, type NoteType } from "@vibevalley/protocol";
import { issueId, messageId, noteId } from "@vibevalley/protocol/schema";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";
import { buildPromotedIssueDraft, buildPromotedNoteContent, buildPromotedNoteDraft, messageSourcePath } from "../model/promote";

const sampleNote: Note = {
  id: noteId("note-saved-msg"),
  title: "设计稿和录屏在这，参考 https://example.com/design",
  noteType: "doc",
  sortOrder: 0,
  channel: "general",
  said: { channel: "general", number: 12 },
  by: "user",
  byName: "You",
  version: 1,
  seq: 1,
  versions: [],
  at: SCENARIO_NOW,
  updated: SCENARIO_NOW,
};

function respondNoteDefaults(fake: ReturnType<typeof fakeHost>, list: Note[] = [sampleNote]) {
  fake.respond("note.list", () => list);
  fake.respond("note.get", () => list[0] ?? sampleNote);
  fake.respond("note.file.list", () => ({ noteId: (list[0] ?? sampleNote).id, seq: 1, files: [] }));
  fake.respond("note.doc.view", () => ({
    noteId: (list[0] ?? sampleNote).id,
    title: (list[0] ?? sampleNote).title,
    blocks: [{ id: "b1", type: "prose", text: "Saved note body" }],
    slideCount: 1,
    wordCount: 3,
    extractedLinks: [],
  }));
  fake.respond("note.link.list", () => ({ outgoing: [], backlinks: [] }));
  fake.respond("note.suggestion.list", () => []);
  fake.respond("note.history.list", () => []);
  fake.respond("note.type.list", () => []);
}

test("promote helpers carry /chat/<channel>?m=<seq> back-links, body, attachments, and 3+1 note JSON payloads", () => {
  setLocale("en");
  const channel: Channel = {
    id: "design",
    type: "channel",
    default: false,
    category: "",
    notify: "all",
    description: "",
    subjectKind: null,
    replies: 0,
    title: "design",
    name: "design",
    repo: "vibevalley",
    at: SCENARIO_NOW,
  };
  const msg: ChatMessage = {
    id: messageId("m-42"),
    number: 42,
    channel: "design",
    from: "user",
    actor: { kind: "user", id: "user", name: "You" },
    name: "You",
    kind: "chat",
    text: "Fix login redirect loop\nCheck session expiry handling.",
    at: SCENARIO_NOW,
    revision: 1,
    mentions: [],
    spoken: false,
    reactions: [],
    attachments: [
      { id: "att-img", name: "flow.png", type: "image/png", size: 1200 },
      { id: "att-pdf", name: "spec.pdf", type: "application/pdf", size: 4200 },
    ],
    embeds: [],
    outcome: null,
  };

  expect(messageSourcePath(msg)).toBe("/chat/design?m=42");

  const issueDraft = buildPromotedIssueDraft(msg, channel);
  expect(issueDraft.repo).toBe("vibevalley");
  expect(issueDraft.attachmentFiles).toHaveLength(2);
  expect(issueDraft.text).toContain("Fix login redirect loop");
  expect(issueDraft.text).toContain("/chat/design?m=42");

  const noteDraft = buildPromotedNoteDraft(msg, channel);
  expect(noteDraft.title).toBe("Fix login redirect loop");
  expect(noteDraft.backLink).toBe("/chat/design?m=42");
  expect(noteDraft.content).toContain("![flow.png](/api/v1/attachment/att-img)");
  expect(noteDraft.content).toContain("[spec.pdf](/api/v1/attachment/att-pdf)");
  expect(noteDraft.content).toContain("/chat/design?m=42");

  const docJson = JSON.parse(buildPromotedNoteContent({ title: noteDraft.title, noteType: "doc", content: noteDraft.content })) as {
    version: number;
    blocks: { type: string; text?: string }[];
  };
  expect(docJson.version).toBe(1);
  expect(docJson.blocks.some((b) => b.type === "prose" && (b.text ?? "").includes("Fix login redirect loop"))).toBe(true);
  expect(docJson.blocks.some((b) => b.type === "quote" && (b.text ?? "").includes("/chat/design?m=42"))).toBe(true);

  const baseJson = JSON.parse(buildPromotedNoteContent({ title: noteDraft.title, noteType: "base", content: noteDraft.content })) as {
    sheets: { name: string; rows: unknown[] }[];
  };
  expect(baseJson.sheets[0]?.name).toBe("Fix login redirect loop");
  expect(baseJson.sheets[0]?.rows).toHaveLength(1);
});

test("MessageTools overflow promotes a channel message to NewIssue with body, attachments, and back-link", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  respondNoteDefaults(fake);

  const createdIssues: { title?: string; description?: string; attachments?: string[] }[] = [];
  const baseIssue = scenarios.typical.state.board.issues[0];
  fake.respond("issue.create", (payload: unknown): Issue => {
    const p = payload as { title?: string; description?: string; attachments?: string[] };
    createdIssues.push(p);
    return {
      ...baseIssue,
      id: issueId("i-promoted-1"),
      number: 99,
      title: p.title ?? "Promoted",
      description: p.description ?? "",
    };
  });
  fake.respond("issue.refine", (payload: unknown): Issue => {
    const p = payload as { id: string; text?: string };
    return { ...baseIssue, id: issueId(p.id), number: 99, title: p.text ?? "Promoted" };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-head") === 1);

  await app.hover("text:设计稿和录屏在这，参考 https://example.com/design");
  await fake.pumpUntil(app, () => app.count("id:message-tool-more") === 1);
  await app.press("id:message-tool-more");
  await fake.pumpUntil(app, () => app.count("id:more-promote-issue") === 1);
  await app.press("id:more-promote-issue");

  await fake.pumpUntil(app, () => app.count("id:issue-new-dialog") === 1);
  const prefilled = app.value("id:issue-new-text");
  expect(prefilled).toContain("设计稿和录屏在这");
  expect(prefilled).toContain("/chat/general?m=7");
  expect(app.count("id:issue-attachment-tile")).toBe(4);

  await app.press("id:issue-new-keep");
  await fake.pumpUntil(app, () => createdIssues.length === 1);
  expect(createdIssues[0]?.title).toContain("/chat/general?m=7");
  expect(createdIssues[0]?.attachments).toEqual(["a1", "a2", "a3", "a4"]);
});

test("MessageTools overflow saves a channel message as a note with channel source and back-link", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/chat", locale: "en" });
  respondNoteDefaults(fake);

  const createdNotes: { title?: string; noteType?: NoteType; channel?: string; content?: string }[] = [];
  fake.respond("note.create", (payload: unknown) => {
    const p = payload as { title?: string; noteType?: NoteType; channel?: string; content?: string };
    createdNotes.push(p);
    return {
      ...sampleNote,
      title: p.title ?? sampleNote.title,
      noteType: p.noteType ?? "doc",
      channel: p.channel ?? "general",
    };
  });

  const app = await open("../../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:channel-head") === 1);

  await app.hover("text:设计稿和录屏在这，参考 https://example.com/design");
  await fake.pumpUntil(app, () => app.count("id:message-tool-more") === 1);
  await app.press("id:message-tool-more");
  await fake.pumpUntil(app, () => app.count("id:more-save-note") === 1);
  await app.press("id:more-save-note");

  await fake.pumpUntil(app, () => app.count("id:save-note-dialog") === 1);
  expect(app.value("id:save-note-title")).toContain("设计稿和录屏在这");
  const content = app.value("id:save-note-content");
  expect(content).toContain("/chat/general?m=7");
  expect(content).toContain("/api/v1/attachment/a3");

  await app.press("id:save-note-submit");
  await fake.pumpUntil(app, () => createdNotes.length === 1);
  expect(createdNotes[0]).toMatchObject({
    noteType: "doc",
    channel: "general",
  });
  expect(createdNotes[0]?.content ?? "").toContain("/chat/general?m=7");
  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);
});
