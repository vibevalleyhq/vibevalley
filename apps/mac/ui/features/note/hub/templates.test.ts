import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { NOTE_TYPES, type NoteType } from "@vibevalley/protocol";

import { buildDocFromMarkdown } from "../html";
import { CONTENT_TEMPLATES, templateBadge, templateDesc, templateIcon, templateMatchesQuery, templateName, templateNoteType } from "./templates";
import { buildDeliverableSeedFiles, buildWhiteboardDocument, noteStarterMarkdown } from "./templateSeeds";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

test("content templates expose 66 unique entries covering all 3+1 note primitives", () => {
  expect(CONTENT_TEMPLATES.length).toBe(66);
  expect(new Set(CONTENT_TEMPLATES.map((t) => t.id)).size).toBe(66);
  expect(new Set(CONTENT_TEMPLATES.map((t) => t.key)).size).toBe(66);

  const coveredTypes = new Set<NoteType>();
  for (const tpl of CONTENT_TEMPLATES) {
    const nt = templateNoteType(tpl);
    if (nt !== undefined) coveredTypes.add(nt);
  }
  for (const noteType of NOTE_TYPES) {
    expect(coveredTypes.has(noteType)).toBe(true);
  }

  const engineeringCount = CONTENT_TEMPLATES.filter((t) => t.engineering === true).length;
  expect(engineeringCount).toBeGreaterThanOrEqual(30);

  const standaloneAppCount = CONTENT_TEMPLATES.filter((t) => t.standaloneApp === true).length;
  expect(standaloneAppCount).toBeGreaterThanOrEqual(8);
});

test("all templates resolve non-empty localized names, descriptions, icons, and badges in zh and en", () => {
  for (const locale of ["zh", "en"] as const) {
    setLocale(locale);
    for (const tpl of CONTENT_TEMPLATES) {
      expect(templateName(tpl).trim().length).toBeGreaterThan(0);
      expect(templateDesc(tpl).trim().length).toBeGreaterThan(0);
      expect(templateBadge(tpl).trim().length).toBeGreaterThan(0);
      expect(templateIcon(tpl).length).toBeGreaterThan(0);
    }
  }
});

test("every doc, canvas, base, and media template generates valid canonical structure files", () => {
  for (const locale of ["zh", "en"] as const) {
    setLocale(locale);
    for (const tpl of CONTENT_TEMPLATES) {
      const title = templateName(tpl);
      if (tpl.kind === "note") {
        const doc = buildDocFromMarkdown(title, noteStarterMarkdown(tpl.variant));
        expect(doc.version).toBe(1);
        expect(doc.blocks.length).toBeGreaterThan(0);
      } else if (tpl.kind === "whiteboard") {
        const board = buildWhiteboardDocument(tpl.variant);
        expect(board.version).toBe(1);
        expect(isRecord(board.elements)).toBe(true);
        expect(Object.keys(board.elements as Record<string, unknown>).length).toBeGreaterThan(0);
      } else if (tpl.kind === "deliverable" && tpl.seed !== undefined) {
        const files = buildDeliverableSeedFiles(tpl.seed, title);
        expect(files.length).toBeGreaterThan(0);
        const byPath = new Map(files.map((f) => [f.path, f]));

        if (tpl.noteType === "doc") {
          const docRaw = byPath.get("structure/doc.json")?.content ?? "{}";
          const doc: unknown = JSON.parse(docRaw);
          expect(isRecord(doc) && doc.version === 1 && Array.isArray(doc.blocks) && doc.blocks.length > 0).toBe(true);
          if (tpl.previewShape === "prototype") {
            const html = byPath.get("structure/index.html")?.content ?? "";
            const css = byPath.get("structure/styles.css")?.content ?? "";
            const js = byPath.get("structure/app.js")?.content ?? "";
            expect(html).toContain('./styles.css"');
            expect(html).toContain('./app.js"');
            expect(css.length).toBeGreaterThan(20);
            expect(js.length).toBeGreaterThan(20);
            expect(html).not.toMatch(/\son[a-z]+\s*=/iu);
          }
        } else if (tpl.noteType === "base") {
          const baseRaw = byPath.get("structure/base.json")?.content ?? "{}";
          const baseDoc: unknown = JSON.parse(baseRaw);
          expect(isRecord(baseDoc) && baseDoc.version === 1 && Array.isArray(baseDoc.sheets) && baseDoc.sheets.length > 0).toBe(true);
          if (isRecord(baseDoc) && Array.isArray(baseDoc.sheets)) {
            for (const sheet of baseDoc.sheets.filter(isRecord)) {
              expect(Array.isArray(sheet.columns) && sheet.columns.length > 0).toBe(true);
              expect(Array.isArray(sheet.rows) && sheet.rows.length > 0).toBe(true);
            }
          }
        } else if (tpl.noteType === "canvas") {
          const boardRaw = byPath.get("structure/board.json")?.content ?? "{}";
          const board: unknown = JSON.parse(boardRaw);
          expect(isRecord(board) && board.version === 1 && isRecord(board.elements)).toBe(true);
        } else if (tpl.noteType === "media") {
          const mediaRaw = byPath.get("structure/media.json")?.content ?? "{}";
          const media: unknown = JSON.parse(mediaRaw);
          expect(isRecord(media) && media.version === 1 && Array.isArray(media.items) && media.items.length > 0).toBe(true);
        }
      }
    }
  }
});

test("templateMatchesQuery matches R&D keywords, note badges, and localized titles", () => {
  setLocale("zh");
  const matchesFor = (q: string) => CONTENT_TEMPLATES.filter((t) => templateMatchesQuery(t, q)).map((t) => t.id);

  expect(matchesFor("RFC")).toContain("tpl-doc-rfc");
  expect(matchesFor("ADR")).toContain("tpl-doc-adr");
  expect(matchesFor("SLO")).toContain("tpl-dash-slo");
  expect(matchesFor("Postmortem")).toContain("tpl-doc-postmortem");
  expect(matchesFor("CI/CD")).toContain("tpl-diag-cicd");
  expect(matchesFor("ER")).toContain("tpl-diag-erd");
  expect(matchesFor("DORA")).toContain("tpl-dash-dora");
  expect(matchesFor("压测")).toContain("tpl-doc-perf");
  expect(matchesFor("时序")).toContain("tpl-diag-sequence");
  expect(matchesFor("番茄钟")).toContain("tpl-proto-focus-studio");
  expect(matchesFor("合成器")).toContain("tpl-proto-synth-pad");
  expect(matchesFor("走查")).toContain("tpl-sheet-ui-review");

  setLocale("en");
  expect(matchesFor("Runbook")).toContain("tpl-doc-runbook");
  expect(matchesFor("Event Storming")).toContain("tpl-wb-event-storming");
  expect(matchesFor("Focus")).toContain("tpl-proto-focus-studio");
  expect(matchesFor("Flow Field")).toContain("tpl-proto-particle-lab");
  expect(matchesFor("Checklist")).toContain("tpl-sheet-ui-review");
});
