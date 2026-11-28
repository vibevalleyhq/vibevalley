import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Issue, type IssueId, localUserParticipant, type Note, type NoteId, type NoteType } from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { fakeHost } from "../../fixtures/fakeHost";
import { responses as noteResponses } from "../../fixtures/notes";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

function makeNote(id: string, title: string, noteType: NoteType = "doc", issue?: IssueId): Note {
  return {
    id: noteId(id),
    title,
    noteType,
    sortOrder: 1,
    ...(issue ? { issue } : {}),
    by: localUserParticipant,
    byName: "You",
    version: 1,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  };
}

function setupInteractiveNotes(initial: Note[], route: string) {
  const store = [...initial];
  const updateCalls: { id: string; issue?: string }[] = [];
  const createCalls: { title: string; noteType: NoteType; issue?: string }[] = [];

  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(noteResponses)) fake.respond(op, answer);

  fake.respond("note.list", (payload: unknown) => {
    const p = (payload ?? {}) as { issue?: string; noteType?: NoteType };
    return store.filter((n) => (p.issue === undefined || n.issue === p.issue) && (p.noteType === undefined || n.noteType === p.noteType));
  });

  fake.respond("note.update", (payload: unknown) => {
    const p = payload as { id: NoteId; title?: string; issue?: string };
    updateCalls.push({ id: p.id, ...(p.issue !== undefined ? { issue: p.issue } : {}) });
    const idx = store.findIndex((n) => n.id === p.id);
    const current = idx >= 0 ? store[idx] : undefined;
    if (!current) return { bizCode: 100004, message: "not found" };
    const next: Note = {
      ...current,
      ...(p.title !== undefined ? { title: p.title } : {}),
    };
    if (p.issue !== undefined) {
      if (p.issue === "") {
        delete (next as { issue?: IssueId }).issue;
      } else {
        (next as { issue?: IssueId }).issue = p.issue as IssueId;
      }
    }
    store[idx] = next;
    return next;
  });

  fake.respond("note.create", (payload: unknown) => {
    const p = payload as { title: string; noteType: NoteType; issue?: string };
    createCalls.push({ title: p.title, noteType: p.noteType, ...(p.issue !== undefined ? { issue: p.issue } : {}) });
    const made = makeNote(`note-created-${store.length + 1}`, p.title, p.noteType, p.issue as IssueId | undefined);
    store.unshift(made);
    return made;
  });

  return { fake, store, updateCalls, createCalls };
}

test("IssueNotes in TodoDetail supports searchable linking, creating a new linked note, and unlinking", async () => {
  setLocale("en");
  const todoIssue: Issue =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo")!;

  const { fake, updateCalls, createCalls } = setupInteractiveNotes(
    [makeNote("note-alpha", "Auth Spec", "doc"), makeNote("note-beta", "Release Board", "canvas")],
    `/issues/${todoIssue.id}`,
  );

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-notes") === 1 && app.count("id:issue-notes-empty") === 1);

  const trigger = app.layout("id:issue-note-link-picker-trigger");
  expect(trigger).not.toBeNull();
  await app.press("id:issue-note-link-picker-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-note-link-picker-search") === 1);
  const searchBox = app.layout("id:issue-note-link-picker-search");
  expect(searchBox).not.toBeNull();
  const triggerBottom = trigger!.y + trigger!.height;
  const searchBottom = searchBox!.y + searchBox!.height;
  expect(searchBox!.y >= triggerBottom - 1 || searchBottom <= trigger!.y + 1).toBe(true);

  await app.type("id:issue-note-link-picker-search", "Auth");
  await fake.pump(app);
  expect(app.texts()).toContain("Auth Spec · Block Doc");
  expect(app.texts()).not.toContain("Release Board · Canvas");
  await app.press("text:Auth Spec · Block Doc");

  await fake.pumpUntil(app, () => app.count("id:issue-note-row-note-alpha") === 1);
  expect(updateCalls).toContainEqual({ id: "note-alpha", issue: todoIssue.id });

  await app.press("id:issue-note-new");
  await fake.pumpUntil(app, () => app.count("id:issue-note-new-dialog") === 1);
  await app.type("id:issue-note-new-title", "Rollout Checklist");
  await app.press("id:issue-note-new-submit");

  await fake.pumpUntil(app, () => createCalls.length === 1 && app.count("id:issue-note-new-dialog") === 0);
  expect(createCalls[0]).toEqual({ title: "Rollout Checklist", noteType: "doc", issue: todoIssue.id });
  await fake.pumpUntil(app, () => app.texts().includes("Rollout Checklist"));

  await app.press("id:issue-note-unlink-note-alpha");
  await fake.pumpUntil(app, () => app.count("id:issue-note-row-note-alpha") === 0);
  expect(updateCalls).toContainEqual({ id: "note-alpha", issue: "" });
});

test("IssueNotes in IssueDetail links and unlinks notes", async () => {
  setLocale("en");
  const allIssues = scenarios.typical.state.board.issues;
  const activeIssue: Issue = allIssues.find((i) => (i.status === "in_progress" || i.status === "in_review") && !allIssues.some((c) => c.parent === i.id))!;

  const { fake, updateCalls } = setupInteractiveNotes(
    [makeNote("note-linked-1", "Existing Spec", "doc", activeIssue.id), makeNote("note-pool-1", "Tracker Sheet", "base")],
    `/issues/${activeIssue.id}`,
  );

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 1100,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-note-row-note-linked-1") === 1);

  await app.press("id:issue-note-link-picker-trigger");
  await fake.pumpUntil(app, () => app.count("id:issue-note-link-picker-search") === 1);
  await app.type("id:issue-note-link-picker-search", "Tracker");
  await fake.pump(app);
  await app.press("text:Tracker Sheet · Base");

  await fake.pumpUntil(app, () => app.count("id:issue-note-row-note-pool-1") === 1);
  expect(updateCalls).toContainEqual({ id: "note-pool-1", issue: activeIssue.id });
  const rowTexts = app.texts();
  expect(rowTexts.some((txt) => txt.includes(".base.json") || txt.includes(".md"))).toBe(false);

  await app.press("id:issue-note-unlink-note-linked-1");
  await fake.pumpUntil(app, () => app.count("id:issue-note-row-note-linked-1") === 0);
  expect(updateCalls).toContainEqual({ id: "note-linked-1", issue: "" });
});
