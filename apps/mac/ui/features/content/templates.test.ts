import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { ARTIFACT_TYPES, type ArtifactType } from "@vibevalley/protocol";

import { buildOutlineFromMarkdown } from "../artifact";
import { CONTENT_TEMPLATES, templateBadge, templateDesc, templateIcon, templateMatchesQuery, templateName } from "./templates";
import { buildDeliverableSeedFiles, buildWhiteboardDocument, noteStarterMarkdown } from "./templateSeeds";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

test("content templates expose 65 unique entries covering all 12 artifact types", () => {
  expect(CONTENT_TEMPLATES.length).toBe(65);
  expect(new Set(CONTENT_TEMPLATES.map((t) => t.id)).size).toBe(65);
  expect(new Set(CONTENT_TEMPLATES.map((t) => t.key)).size).toBe(65);

  const coveredTypes = new Set<ArtifactType>();
  for (const tpl of CONTENT_TEMPLATES) {
    if (tpl.kind === "note") coveredTypes.add("outline");
    else if (tpl.kind === "whiteboard") coveredTypes.add("whiteboard");
    else if (tpl.kind === "deliverable") coveredTypes.add(tpl.artifactType);
  }
  for (const artifactType of ARTIFACT_TYPES) {
    expect(coveredTypes.has(artifactType)).toBe(true);
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

test("every note, whiteboard, and seeded deliverable template generates valid structured files", () => {
  for (const locale of ["zh", "en"] as const) {
    setLocale(locale);
    for (const tpl of CONTENT_TEMPLATES) {
      const title = templateName(tpl);
      if (tpl.kind === "note") {
        const doc = buildOutlineFromMarkdown(title, noteStarterMarkdown(tpl.variant));
        expect(doc.rootIds.length).toBeGreaterThan(0);
        expect(Object.keys(doc.nodes).length).toBeGreaterThan(0);
      } else if (tpl.kind === "whiteboard") {
        const board = buildWhiteboardDocument(tpl.variant);
        expect(board.version).toBe(1);
        expect(isRecord(board.elements)).toBe(true);
        expect(Object.keys(board.elements as Record<string, unknown>).length).toBeGreaterThan(0);
      } else if (tpl.kind === "deliverable" && tpl.seed !== undefined) {
        const files = buildDeliverableSeedFiles(tpl.seed, title);
        expect(files.length).toBeGreaterThan(0);
        const byPath = new Map(files.map((f) => [f.path, f]));

        if (tpl.artifactType === "docs") {
          const entry = byPath.get("structure/index.md");
          expect(entry?.content).toContain(title);
        } else if (tpl.artifactType === "diagram") {
          const raw = byPath.get("structure/diagram.json")?.content ?? "";
          const parsed: unknown = JSON.parse(raw);
          expect(isRecord(parsed)).toBe(true);
          if (isRecord(parsed)) {
            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
            const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
            expect(nodes.length).toBeGreaterThanOrEqual(5);
            expect(edges.length).toBeGreaterThanOrEqual(5);
            const ids = new Set(nodes.filter(isRecord).map((n) => n.id));
            for (const edge of edges.filter(isRecord)) {
              expect(ids.has(edge.from)).toBe(true);
              expect(ids.has(edge.to)).toBe(true);
            }
          }
        } else if (tpl.artifactType === "sheet") {
          const wbRaw = byPath.get("structure/workbook.json")?.content ?? "";
          const wb: unknown = JSON.parse(wbRaw);
          expect(isRecord(wb)).toBe(true);
          if (isRecord(wb) && Array.isArray(wb.sheets)) {
            expect(wb.sheets.length).toBeGreaterThan(0);
            for (const ref of wb.sheets.filter(isRecord)) {
              const sheetFile = typeof ref.file === "string" ? byPath.get(ref.file) : undefined;
              expect(sheetFile).toBeDefined();
              const sheetObj: unknown = JSON.parse(sheetFile?.content ?? "{}");
              expect(isRecord(sheetObj) && Array.isArray(sheetObj.rows) && sheetObj.rows.length > 0).toBe(true);
            }
          }
        } else if (tpl.artifactType === "dashboard") {
          const dashRaw = byPath.get("structure/dashboard.json")?.content ?? "";
          const dash: unknown = JSON.parse(dashRaw);
          expect(isRecord(dash)).toBe(true);
          if (isRecord(dash) && Array.isArray(dash.panels)) {
            expect(dash.panels.length).toBe(4);
            for (const panel of dash.panels.filter(isRecord)) {
              const src = isRecord(panel.source) ? panel.source : undefined;
              const dsPath = typeof src?.dataset === "string" ? src.dataset : "";
              const dsFile = byPath.get(dsPath);
              expect(dsFile).toBeDefined();
              const dsObj: unknown = JSON.parse(dsFile?.content ?? "{}");
              expect(isRecord(dsObj) && Array.isArray(dsObj.rows) && dsObj.rows.length > 0).toBe(true);
            }
          }
        } else if (tpl.artifactType === "slides") {
          const deckRaw = byPath.get("structure/deck.json")?.content ?? "";
          const deck: unknown = JSON.parse(deckRaw);
          expect(isRecord(deck)).toBe(true);
          if (isRecord(deck) && Array.isArray(deck.slides)) {
            expect(deck.slides.length).toBe(5);
            const firstSlide = deck.slides[0];
            expect(isRecord(firstSlide) && firstSlide.file === "structure/slides/s01-cover.json").toBe(true);
            for (const ref of deck.slides.filter(isRecord)) {
              const slideFile = typeof ref.file === "string" ? byPath.get(ref.file) : undefined;
              expect(slideFile).toBeDefined();
            }
          }
        } else if (tpl.artifactType === "prototype") {
          const html = byPath.get("structure/index.html")?.content ?? "";
          const css = byPath.get("structure/styles.css")?.content ?? "";
          const js = byPath.get("structure/app.js")?.content ?? "";
          expect(html).toContain('./styles.css"');
          expect(html).toContain('./app.js"');
          expect(css.length).toBeGreaterThan(20);
          expect(js.length).toBeGreaterThan(20);
          expect(html).not.toMatch(/\son[a-z]+\s*=/iu);
        } else if (tpl.artifactType === "design") {
          const frameRaw = byPath.get("structure/frames/main.json")?.content ?? "{}";
          const frame: unknown = JSON.parse(frameRaw);
          expect(isRecord(frame) && isRecord(frame.root)).toBe(true);
        } else if (tpl.artifactType === "design-system") {
          const tokensRaw = byPath.get("structure/tokens.json")?.content ?? "{}";
          const tokens: unknown = JSON.parse(tokensRaw);
          expect(isRecord(tokens) && Array.isArray(tokens.color)).toBe(true);
        } else if (tpl.artifactType === "motion") {
          const tlRaw = byPath.get("structure/timeline.json")?.content ?? "{}";
          const tl: unknown = JSON.parse(tlRaw);
          expect(isRecord(tl) && Array.isArray(tl.scenes) && tl.scenes.length > 0).toBe(true);
        } else if (tpl.artifactType === "storyboard") {
          const sbRaw = byPath.get("structure/shots.json")?.content ?? "{}";
          const sb: unknown = JSON.parse(sbRaw);
          expect(isRecord(sb) && Array.isArray(sb.shots) && sb.shots.length > 0).toBe(true);
        }
      }
    }
  }
});

test("templateMatchesQuery matches R&D keywords, artifact badges, and localized titles", () => {
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

  setLocale("en");
  expect(matchesFor("Runbook")).toContain("tpl-doc-runbook");
  expect(matchesFor("Event Storming")).toContain("tpl-wb-event-storming");
  expect(matchesFor("Focus")).toContain("tpl-proto-focus-studio");
  expect(matchesFor("Flow Field")).toContain("tpl-proto-particle-lab");
});
