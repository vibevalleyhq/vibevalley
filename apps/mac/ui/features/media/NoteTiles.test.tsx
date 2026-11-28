import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { localUserParticipant, type Note, type NotePreview, type NoteType } from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { cleanPreviewText } from "./NotePreview";
import { noteMetaLine } from "./Tiles";

function makeNote(over: {
  readonly id: string;
  readonly title: string;
  readonly noteType: NoteType;
  readonly by?: string;
  readonly byName?: string;
  readonly version?: number;
  readonly seq?: number;
  readonly preview?: NotePreview;
  readonly cover?: Note["cover"];
}): Note {
  return {
    id: noteId(over.id),
    title: over.title,
    noteType: over.noteType,
    sortOrder: 0,
    by: over.by ?? localUserParticipant,
    byName: over.byName ?? "You",
    version: over.version ?? 0,
    seq: over.seq ?? 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
    ...(over.preview !== undefined ? { preview: over.preview } : {}),
    ...(over.cover !== undefined ? { cover: over.cover } : {}),
  };
}

async function mountLibrary(notes: readonly Note[], configure?: (fake: FakeHost) => void, opts?: { readonly colorScheme?: "light" | "dark" }) {
  const fake = fakeHost(scenarios.typical, { route: "/library", locale: "en" });
  fake.respond("note.list", () => notes);
  fake.respond("note.type.list", () => []);
  fake.respond("host.appletList", () => []);
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 800,
    colorScheme: opts?.colorScheme ?? "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:library-notes") === 1);
  return { app, fake };
}

test("noteMetaLine omits local default user name and shows agent collaborator name", () => {
  setLocale("en");
  const mine = makeNote({ id: "n-mine", title: "Spec", noteType: "doc", by: localUserParticipant, byName: "LocalUser", version: 2 });
  const lineMine = noteMetaLine(mine, SCENARIO_NOW);
  expect(lineMine).toContain(t("web.note.types.doc"));
  expect(lineMine).toContain(t("web.library.inspector.versionBadge", { version: 2 }));
  expect(lineMine).not.toContain("LocalUser");

  const agent = makeNote({ id: "n-agent", title: "Tracker", noteType: "base", by: "w1", byName: "Alex", version: 1 });
  const lineAgent = noteMetaLine(agent, SCENARIO_NOW);
  expect(lineAgent).toContain(t("web.note.types.base"));
  expect(lineAgent).toContain("Alex");
  expect(lineAgent).toContain(t("web.library.inspector.versionBadge", { version: 1 }));
});

test("NoteTiles renders all 3+1 structured previews, covers, and clean installed-applet footer", async () => {
  setLocale("en");
  const allFour: readonly Note[] = [
    makeNote({
      id: "p-doc",
      title: "Architecture RFC",
      noteType: "doc",
      preview: {
        _tag: "doc",
        heading: "Core Goals",
        excerpt: "Keep storage consolidated and projections pure.",
        blockCount: 6,
        slideCount: 2,
        outline: [{ depth: 1, text: "Core Goals", kind: "heading" }],
      },
    }),
    makeNote({
      id: "p-base",
      title: "Benchmarks",
      noteType: "base",
      preview: {
        _tag: "base",
        sheetName: "QPS",
        columns: ["Case", "QPS", "P99"],
        rows: [
          ["List", "1240", "8ms"],
          ["Write", "640", "14ms"],
        ],
        totalRows: 12,
        totalCols: 3,
      },
    }),
    makeNote({
      id: "p-canvas",
      title: "System Map",
      noteType: "canvas",
      preview: {
        _tag: "canvas",
        shapes: [
          { x: 0.1, y: 0.1, w: 0.3, h: 0.25, kind: "card", label: "Gateway" },
          { x: 0.55, y: 0.45, w: 0.3, h: 0.25, kind: "sticky", label: "Core" },
        ],
        nodeCount: 2,
      },
    }),
    makeNote({
      id: "p-media",
      title: "Launch Reel",
      noteType: "media",
      preview: {
        _tag: "media",
        mediaKind: "video",
        caption: "Opening Hook",
        durationSec: 8,
      },
    }),
    makeNote({
      id: "p-doc-covered",
      title: "Synth Pad",
      noteType: "doc",
      cover: {
        path: "/tmp/demo-cover-1.png",
        url: "/api/v1/note/p-doc-covered/cover?seq=1",
        mime: "image/png",
        seq: 1,
        width: 640,
        height: 400,
        updatedAt: SCENARIO_NOW,
      },
    }),
  ];

  const { app } = await mountLibrary(allFour, (fake) => {
    fake.respond("host.appletList", () => [
      {
        noteId: "p-doc-covered",
        noteType: "doc",
        appName: "Synth Pad",
        bundleId: "dev.vibevalley.applet.p-doc-covered",
        bundlePath: "/Users/demo/Applications/VibeValley Apps/Synth Pad.app",
        alwaysOnTop: false,
        installed: true,
      },
    ]);
  });

  for (const note of allFour) {
    expect(app.count(`id:library-note-${note.id}`)).toBe(1);
  }
  expect(app.count("id:library-note-cover-p-doc-covered")).toBe(1);
  expect(app.count("id:library-note-preview-p-doc-covered")).toBe(0);
  expect(app.count("id:library-note-preview-p-doc")).toBe(1);
  expect(app.count("id:library-note-open-app-p-doc-covered")).toBe(1);
  expect(app.count("id:library-note-manage-app-p-doc-covered")).toBe(1);

  const texts = app.texts();
  expect(texts).toContain("Core Goals");
  expect(texts).toContain("1240");
  expect(texts).toContain("Opening Hook");
  expect(texts).not.toContain(t("web.note.applet.badgeInstalled"));

  const first = app.layout("id:library-note-p-doc");
  const second = app.layout("id:library-note-p-base");
  const third = app.layout("id:library-note-p-canvas");
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();
  expect(second!.y).toBe(first!.y);
  expect(third!.y).toBe(first!.y);
  expect(second!.x).toBeGreaterThan(first!.x);
  expect(third!.x).toBeGreaterThan(second!.x);
  expect(app.count("id:library-note-cover-p-doc-covered-scrim")).toBe(0);
});

test("cleanPreviewText strips markdown syntax, resolves wikilinks, and hides data URIs", () => {
  setLocale("en");
  const notesById = new Map([["note_abc", { title: "Roadmap Spec" }]]);
  const issuesById = new Map([["iss_9", { number: 9, title: "Fix clip" }]]);
  expect(cleanPreviewText("## **Bold** and `code` > quote with __underline__")).toBe("Bold and code > quote with underline");
  expect(
    cleanPreviewText("See [[note:note_xyz|Design Doc]], [[note:note_abc]], [[note:note_missing]], [[issue:i5]], and [[issue:iss_9]]", {
      notesById,
      issuesById,
    }),
  ).toBe(`See Design Doc, Roadmap Spec, ${t("web.note.types.doc")}, #5, and #9`);
  expect(cleanPreviewText("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBe("");
});

test("Library sidebar shows compact Notion-style nav with auto-hidden Pinned, horizontal library filter chips, and dark mode cover scrim", async () => {
  setLocale("en");
  const subset: readonly Note[] = [
    makeNote({
      id: "p-doc",
      title: "Architecture RFC",
      noteType: "doc",
      preview: {
        _tag: "doc",
        heading: "Architecture RFC",
        excerpt: "**Concise** spec referencing [[issue:i5]] and `tokens`.",
        blockCount: 2,
        slideCount: 1,
        outline: [],
      },
    }),
    makeNote({
      id: "p-doc-covered",
      title: "Synth Pad",
      noteType: "doc",
      cover: {
        path: "/tmp/demo-cover-1.png",
        url: "/api/v1/note/p-doc-covered/cover?seq=1",
        mime: "image/png",
        seq: 1,
        width: 640,
        height: 400,
        updatedAt: SCENARIO_NOW,
      },
    }),
  ];

  const { app, fake } = await mountLibrary(subset, undefined, { colorScheme: "dark" });
  expect(app.count("id:library-note-cover-p-doc-covered-scrim")).toBe(1);
  expect(app.count("id:library-type-chips")).toBe(1);
  expect(app.count("id:content-nav-note-doc")).toBe(1);
  expect(app.count("id:content-pinned-section")).toBe(0);

  // Duplicate title in DocPreview is suppressed (appears once in footer, once in PageTree = 2, not 3).
  const texts = app.texts();
  expect(texts.filter((x) => x === "Architecture RFC").length).toBe(2);
  expect(texts).toContain("Concise spec referencing #5 and tokens.");

  // Pinning a note reveals the inline Pinned section in the sidebar.
  await app.press("id:library-note-pin-p-doc");
  await fake.pumpUntil(app, () => app.count("id:content-pinned-section") === 1);
  expect(app.count("id:content-pinned-note-p-doc")).toBe(1);
});

test("LibraryPage filters notes and media by repo, issue, and channel and collapses filter bar on narrow widths", async () => {
  setLocale("en");
  const { app, fake } = await mountLibrary(
    [makeNote({ id: "note-vv", title: "VV Architecture", noteType: "doc" }), makeNote({ id: "note-other", title: "Standalone Base", noteType: "base" })],
    (f) => {
      f.respond("note.list", [
        { ...makeNote({ id: "note-vv", title: "VV Architecture", noteType: "doc" }), issue: "i18", channel: "general" },
        { ...makeNote({ id: "note-other", title: "Standalone Base", noteType: "base" }) },
      ]);
      f.respond("repo.list", [
        { name: "vibevalley", path: "/tmp/vibevalley", branch: "main", branches: ["main"], dirty: false, maxSessions: 4 },
        { name: "site", path: "/tmp/site", branch: "main", branches: ["main"], dirty: false, maxSessions: 2 },
      ]);
    },
  );

  expect(app.count("id:library-filter-bar")).toBe(1);
  expect(app.count("id:library-filter-repo")).toBe(1);
  expect(app.count("id:library-filter-issue")).toBe(1);
  expect(app.count("id:library-filter-channel")).toBe(1);
  expect(app.count("id:library-note-note-vv")).toBe(1);
  expect(app.count("id:library-note-note-other")).toBe(1);

  await app.press("id:library-filter-repo");
  await fake.pump(app);
  await app.press("text:vibevalley");
  await fake.pump(app);
  expect(app.count("id:library-note-note-vv")).toBe(1);
  expect(app.count("id:library-note-note-other")).toBe(0);
  expect(app.count("id:library-filter-clear")).toBe(1);

  await app.press("id:library-filter-clear");
  await fake.pump(app);
  expect(app.count("id:library-note-note-other")).toBe(1);

  await app.setViewport(900, 720);
  await fake.pumpUntil(app, () => app.count("id:library-filter-popover") === 1);
  expect(app.count("id:library-filter-bar")).toBe(0);
});
