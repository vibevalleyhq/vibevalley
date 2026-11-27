import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { DocView, Issue, IssueId, Note, NoteId, Suggestion, SuggestionId } from "@vibevalley/protocol";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

function makeDocNote(id: string, issueId: string, title: string): Note {
  return {
    id: id as NoteId,
    title,
    noteType: "doc",
    issue: issueId as IssueId,
    seq: 1,
    version: 1,
    versions: [],
    by: "user",
    byName: "User",
    at: SCENARIO_NOW - 10_000,
    updated: SCENARIO_NOW - 1_000,
    sortOrder: 0,
  };
}

function makeDocView(noteId: string, title = "Issue Body"): DocView {
  return {
    noteId: noteId as NoteId,
    title,
    blocks: [
      { id: "b1", type: "heading", level: 2, text: "Design Goal" },
      { id: "b2", type: "prose", text: "Keep rich collaborative blocks synchronized with issue.description." },
    ],
    wordCount: 10,
    slideCount: 0,
    extractedLinks: [],
  };
}

test("TodoDetail lazily materializes issue body into embedded BlockDocView without duplicate title input", async () => {
  setLocale("en");
  const baseTodo =
    scenarios.typical.state.board.issues.find((i) => i.status === "backlog") ?? scenarios.typical.state.board.issues.find((i) => i.status === "todo");
  if (!baseTodo) throw new Error("typical scenario must include a backlog or todo issue");
  const draftTodo: Issue = {
    ...baseTodo,
    status: "backlog",
    description: "## Existing Context\n\nLegacy markdown summary.",
    stage: { state: "draft", acts: [] },
  };
  const bodyNote = makeDocNote("note-body-1", draftTodo.id, draftTodo.title);
  const docView = makeDocView(bodyNote.id);
  const state = {
    ...scenarios.typical.state,
    board: {
      ...scenarios.typical.state.board,
      issues: scenarios.typical.state.board.issues.map((i) => (i.id === draftTodo.id ? draftTodo : i)),
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${draftTodo.id}`, locale: "en" });
  fake.respond("issue.body.ensure", () => ({
    issue: { ...draftTodo, bodyNoteId: bodyNote.id },
    note: bodyNote,
    docView,
  }));
  fake.respond("note.get", () => bodyNote);
  fake.respond("note.doc.view", () => docView);
  fake.respond("note.link.list", () => ({ outgoing: [], backlinks: [] }));
  fake.respond("note.suggestion.list", () => []);

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 850,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-description-preview") === 1 && app.count("id:issue-edit-description") === 1);

  await app.press("id:issue-edit-description");
  await fake.pumpUntil(app, () => app.count("id:note-block-doc-view") === 1 && app.count("id:doc-blocks-list") === 1);

  expect(fake.calls.some((c) => c.op === "issue.body.ensure")).toBe(true);
  expect(app.count("id:doc-title-input")).toBe(0);
  expect(app.count("id:issue-open-body-note")).toBe(1);
});

test("IssueDetail renders pending agent note_suggestion on materialized body and accepts it", async () => {
  setLocale("en");
  const baseActive = scenarios.typical.state.board.issues.find((i) => i.status === "in_progress" || i.status === "in_review");
  if (!baseActive) throw new Error("typical scenario must include an active issue");
  const bodyNote = makeDocNote("note-body-2", baseActive.id, baseActive.title);
  const activeIssue: Issue = {
    ...baseActive,
    bodyNoteId: bodyNote.id,
  };
  const docView = makeDocView(bodyNote.id);
  let suggestions: Suggestion[] = [
    {
      id: "sug-agent-1" as SuggestionId,
      noteId: bodyNote.id,
      path: "structure/doc.json",
      author: "agent:arch",
      baseRev: 1,
      change: { content: "{}", summary: "Add rollout verification checklist" },
      status: "open",
      createdAt: SCENARIO_NOW - 500,
    },
  ];
  const state = {
    ...scenarios.typical.state,
    board: {
      ...scenarios.typical.state.board,
      issues: scenarios.typical.state.board.issues.map((i) => (i.id === activeIssue.id ? activeIssue : i)),
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${activeIssue.id}`, locale: "en" });
  fake.respond("note.get", () => bodyNote);
  fake.respond("note.doc.view", () => docView);
  fake.respond("note.link.list", () => ({ outgoing: [], backlinks: [] }));
  fake.respond("note.suggestion.list", () => suggestions);
  fake.respond("note.suggestion.accept", () => {
    const accepted: Suggestion = { ...suggestions[0], status: "accepted", resolvedAt: SCENARIO_NOW };
    suggestions = [accepted];
    return accepted;
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 900,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-body-suggestion") === 1 && app.count("id:note-block-doc-view") === 1);
  expect(app.texts().join("\n")).toContain("Add rollout verification checklist");

  await app.press("id:issue-body-suggestion-accept");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.suggestion.accept") && app.count("id:issue-body-suggestion") === 0);
});

test("FamilyDetail renders collaborative body editor, IssueNotes, and IssueActivity fallback composer", async () => {
  setLocale("en");
  const sample = scenarios.typical.state.board.issues.at(0);
  if (sample === undefined) throw new Error("typical scenario must include issues");
  const parentIssue: Issue = {
    ...sample,
    id: "i-family-1" as IssueId,
    number: 88,
    title: "Epic unified body parity",
    description: "Family scope overview",
    status: "in_progress",
    owner: { kind: "user", id: "user" },
    parent: undefined,
    stage: { state: "working", acts: [] },
  };
  const childIssue: Issue = {
    ...sample,
    id: "i-family-child" as IssueId,
    number: 89,
    title: "Child sub-issue",
    parent: parentIssue.id,
  };
  const state = {
    ...scenarios.typical.state,
    board: {
      ...scenarios.typical.state.board,
      issues: [parentIssue, childIssue],
    },
  };
  const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${parentIssue.id}`, locale: "en" });
  fake.respond("issue.conversation.get", () => null);
  fake.respond("note.link.list", () => ({ outgoing: [], backlinks: [] }));

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 950,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:issue-family") === 1 && app.count("id:issue-requirement") === 1 && app.count("id:issue-activity") === 1);
  expect(app.count("id:issue-comment-fallback-composer")).toBe(1);
  expect(app.count("id:issue-notes")).toBe(1);
  expect(app.texts()).not.toContain("user");
});
