import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { NOTE_TYPE_SPECS, NOTE_TYPES, NoteTypeValues, userId } from "@vibevalley/protocol";

import { tone } from "../../design/tone";
import { decodeBase64Utf8 } from "../../infra/attachment";
import { formatGenUiAction } from "../../infra/rich";
import { buildDocFromMarkdown, entryPathOf, inferNoteFromName, noteSuffixOf } from "./html";
import { noteTypeIcon, noteTypeLabel } from "./NoteCard";
import { presenceHighlightCommand } from "./shell";
import { elapsedText, presenterHref, presenterOf, stepped } from "./slides";

test("covers all 3+1 NoteType metadata entries, labels, icons, suffixes, and entry paths", () => {
  expect(NoteTypeValues).toHaveLength(4);
  expect(NOTE_TYPES).toEqual(NoteTypeValues);
  expect(Object.keys(NOTE_TYPE_SPECS)).toEqual([...NOTE_TYPES]);
  for (const type of NOTE_TYPES) {
    const spec = NOTE_TYPE_SPECS[type];
    expect(spec.noteType).toBe(type);
    expect(noteTypeLabel(type).length).toBeGreaterThan(0);
    expect(noteTypeIcon[type].length).toBeGreaterThan(0);
    expect(noteSuffixOf({ noteType: type })).toBe(spec.exportSuffix);
    expect(entryPathOf(type)).toBe(spec.entryPath);
    expect(entryPathOf(type)).toMatch(/^structure\//u);
  }
});

test("regression: all 3+1 NoteType labels render localized Chinese without English fallback", () => {
  setLocale("zh");
  try {
    const labels = NOTE_TYPES.map((type) => [type, noteTypeLabel(type)] as const);
    for (const [, label] of labels) {
      expect(label).toMatch(/\p{Script=Han}/u);
    }
    expect(new Map(labels).get("doc")).toBe("块文档");
    expect(new Map(labels).get("base")).toBe("多维库");
    expect(new Map(labels).get("canvas")).toBe("自由画布");
    expect(new Map(labels).get("media")).toBe("媒体记录");
  } finally {
    setLocale("en");
  }
});

test("infers all 3+1 note primitives from legacy and canonical filenames", () => {
  expect(inferNoteFromName("q3-deck.slides.json")).toEqual({ title: "q3-deck", noteType: "doc" });
  expect(inferNoteFromName("kpi.dashboard.json")).toEqual({ title: "kpi", noteType: "doc" });
  expect(inferNoteFromName("weekly.outline.json")).toEqual({ title: "weekly", noteType: "doc" });
  expect(inferNoteFromName("demo.html")).toEqual({ title: "demo", noteType: "doc" });
  expect(inferNoteFromName("notes.doc.md")).toEqual({ title: "notes", noteType: "doc" });
  expect(inferNoteFromName("budget.sheet.json")).toEqual({ title: "budget", noteType: "base" });
  expect(inferNoteFromName("tracker.base.json")).toEqual({ title: "tracker", noteType: "base" });
  expect(inferNoteFromName("pipeline.whiteboard.json")).toEqual({ title: "pipeline", noteType: "canvas" });
  expect(inferNoteFromName("poster.design.json")).toEqual({ title: "poster", noteType: "canvas" });
  expect(inferNoteFromName("brand.tokens.json")).toEqual({ title: "brand", noteType: "canvas" });
  expect(inferNoteFromName("intro.motion.json")).toEqual({ title: "intro", noteType: "media" });
  expect(inferNoteFromName("launch.storyboard.json")).toEqual({ title: "launch", noteType: "media" });
});

test("buildDocFromMarkdown creates canonical structure/doc.json blocks", () => {
  const doc = buildDocFromMarkdown("Launch", "## Roadmap\n- Ship UI\n- [x] Run checks\n> Ship small\n---\n");
  expect(doc.version).toBe(1);
  expect(doc.blocks.some((b) => b.type === "heading" && b.text === "Roadmap")).toBe(true);
  expect(doc.blocks.some((b) => b.type === "list" && b.items.includes("Ship UI"))).toBe(true);
  expect(doc.blocks.some((b) => b.type === "todo" && b.checked && b.text === "Run checks")).toBe(true);
  expect(doc.blocks.some((b) => b.type === "quote" && b.text === "Ship small")).toBe(true);
  expect(doc.blocks.some((b) => b.type === "divider")).toBe(true);
});

test("presenceHighlightCommand filters local user, scopes by path, and normalizes highlight colors", () => {
  const cmd = presenceHighlightCommand(
    [
      { id: userId, name: "Me", kind: "highlight", selector: "#local", updatedAt: 1 },
      {
        id: "session:1",
        name: "老周",
        color: "coral",
        kind: "highlight",
        selector: ".kpi-card",
        status: "核对指标",
        path: "structure/doc.json",
        updatedAt: 2,
      },
      { id: "session:2", name: "小美", color: "#2f9d8f", kind: "cursor", x: 120, y: 80, w: 64, h: 32, path: "structure/other.json", updatedAt: 3 },
      { id: "session:3", name: "助手", color: "teal", kind: "selection", x: 10, y: 20, updatedAt: 4 },
    ],
    { path: "structure/doc.json" },
  );
  expect(cmd).toEqual({
    vibevalley: "presence-highlight",
    items: [
      { id: "session:1", name: "老周", color: tone("accent"), selector: ".kpi-card", status: "核对指标" },
      { id: "session:3", name: "助手", color: tone("leaf"), x: 10, y: 20 },
    ],
  });
});

test("presenterHref, presenterOf, stepped, and elapsedText format presenter links and timing", () => {
  expect(presenterHref({ id: "note-1" })).toBe("/present?note=note-1");
  expect(presenterHref({ id: "note-1", version: 3 })).toBe("/present?note=note-1&v=3");
  expect(presenterOf("?note=note-1&v=2")).toEqual({ id: "note-1", version: 2 });
  expect(stepped({ at: 0, step: 1, pages: 3 })).toBe(1);
  expect(stepped({ at: 2, step: 1, pages: 3 })).toBe(2);
  expect(elapsedText(65_000)).toBe("1:05");
});

test("decodes UTF-8 base64 markdown and formats GenUI action payloads cleanly", () => {
  const md = "# 大纲导入\n- [ ] 验证 UTF-8 编码";
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(md)));
  expect(decodeBase64Utf8(b64)).toBe(md);

  expect(formatGenUiAction({ action: "state_change", payload: "rate=7.5" })).toBe("rate=7.5");
  expect(formatGenUiAction({ action: "submit", payload: "approved=true" })).toBe("submit: approved=true");
  expect(formatGenUiAction({ action: "confirm", payload: "" })).toBe("confirm");
  expect(formatGenUiAction({ action: "", payload: "fallback" })).toBe("fallback");
});
