import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Note, type NoteId, userId } from "@vibevalley/protocol";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { responses as noteResponses } from "../../fixtures/notes";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

async function mountNoteRoute(route: string, configure?: (fake: FakeHost) => void) {
  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(noteResponses)) {
    fake.respond(op, answer);
  }
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);
  return { app, fake };
}

test("NotePage opens directory files mode and history panel via header controls", async () => {
  setLocale("en");
  const nid = "art-login" as NoteId;
  const { app, fake } = await mountNoteRoute(`/notes/${nid}`);

  expect(app.count("id:note-title")).toBe(1);
  expect(app.texts()).toContain("登录流程");
  expect(app.count("id:note-version-badge")).toBe(1);

  await app.press("id:collab-toggle-history");
  await fake.pumpUntil(app, () => app.count("id:note-history-panel") === 1);

  await app.press("id:note-more");
  await fake.pumpUntil(app, () => app.count("id:note-view-mode") === 1);
  await app.press("id:note-view-mode");
  await fake.pumpUntil(app, () => app.count("id:note-directory-view") === 1);
});

test("PageTree lists hierarchy and triggers note.create for root notes", async () => {
  setLocale("en");
  const rootNote: Note = {
    id: "note-root-1" as NoteId,
    title: "Engineering Hub",
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
  const { app, fake } = await mountNoteRoute(`/notes/${rootNote.id}`, (f) => {
    f.respond("note.get", () => rootNote);
    f.respond("note.list", () => [rootNote]);
  });

  expect(app.count("id:page-tree")).toBe(1);
  expect(app.count("id:page-tree-item-note-root-1")).toBe(1);
  expect(app.texts()).toContain("Engineering Hub");

  await app.press("id:page-tree-add-root");
  await fake.pumpUntil(app, () => app.count("id:page-tree-add-root-doc") === 1);
  fake.clearCalls();
  await app.press("id:page-tree-add-root-doc");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.create"));
  expect(fake.calls.find((c) => c.op === "note.create")?.payload).toMatchObject({ noteType: "doc" });
});
