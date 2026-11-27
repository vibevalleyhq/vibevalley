import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Note, type NoteId, userId } from "@vibevalley/protocol";

import { fakeHost } from "../../fixtures/fakeHost";
import { responses as noteResponses } from "../../fixtures/notes";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

function makeDocNote(id: string): Note {
  return {
    id: id as NoteId,
    title: "Responsive Doc Note",
    noteType: "doc",
    sortOrder: 1,
    by: userId,
    byName: "You",
    version: 0,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  };
}

async function mountNoteAt(width: number, height: number) {
  setLocale("en");
  const note = makeDocNote("note-resp-doc");
  const fake = fakeHost(scenarios.typical, { route: `/notes/${note.id}`, locale: "en" });
  for (const [op, answer] of Object.entries(noteResponses)) {
    fake.respond(op, answer);
  }
  fake.respond("note.get", () => note);
  fake.respond("note.list", () => [note]);
  fake.respond("note.doc.view", () => ({
    noteId: note.id,
    title: note.title,
    blocks: [{ id: "b1", type: "heading", level: 1, text: note.title }],
    slideCount: 1,
    wordCount: 3,
    extractedLinks: [],
  }));
  fake.respond("note.file.list", () => ({ noteId: note.id, seq: 1, files: [] }));

  const app = await open("../../app/main.tsx", {
    width,
    height,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);
  return { app, fake };
}

test("NotePage renders PageTree, full-width header, and toggles right chat rail cleanly", async () => {
  const { app, fake } = await mountNoteAt(900, 720);

  expect(app.count("id:page-tree")).toBe(1);
  expect(app.count("id:note-rail")).toBe(0);
  const headerBox = app.layout("id:note-header");
  expect(headerBox).not.toBeNull();
  expect(headerBox!.width).toBeGreaterThan(400);

  await app.press("id:note-rail-toggle");
  await fake.pumpUntil(app, () => app.count("id:note-rail") === 1);
  expect(app.count("id:note-rail")).toBe(1);

  await app.press("id:note-tree-toggle");
  await fake.pumpUntil(app, () => app.count("id:page-tree") === 0);
  expect(app.count("id:page-tree")).toBe(0);
});
