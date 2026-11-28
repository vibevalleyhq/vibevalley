import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { BaseColumnKindValues, type BaseColumn, type BaseRow, type NoteId } from "@vibevalley/protocol";

import { boardToNativeEntries, parseBoardDocument } from "../WhiteboardView";
import {
  baseCellAsText,
  cleanWikilinkText,
  columnKindIcon,
  defaultCellForColumn,
  formatCompactDateCell,
  formatSummaryValue,
  parseDateRangeCell,
  projectBaseTimeline,
  rowTitleOf,
} from "./baseModel";
import { buildSandboxedHtml } from "./noteFiles";

test("baseModel covers all 12 BaseColumnKinds, default cells, timeline projection, and sandboxed HTML", () => {
  expect(BaseColumnKindValues).toHaveLength(12);
  for (const kind of BaseColumnKindValues) {
    const col: BaseColumn = { id: `c_${kind}`, name: kind, kind };
    expect(columnKindIcon(kind)).toBeTruthy();
    const def = defaultCellForColumn(col);
    expect(typeof baseCellAsText(def)).toBe("string");
  }

  const firstRow: BaseRow = {
    id: "r1",
    pageNoteId: "note-p1" as NoteId,
    createdAt: 1_764_200_000_000,
    updatedAt: 1_764_250_000_000,
    cells: {
      c_title: { _tag: "text", value: "Alpha" },
      c_due: { _tag: "text", value: "2026-12-01 -> 2026-12-04" },
    },
  };
  const rows: BaseRow[] = [firstRow];
  const cols: BaseColumn[] = [
    { id: "c_title", name: "Title", kind: "text" },
    { id: "c_due", name: "Due", kind: "date" },
  ];
  expect(rowTitleOf(firstRow, cols)).toBe("Alpha");
  const tl = projectBaseTimeline(rows, cols, "week");
  expect(tl.dateColumnId).toBe("c_due");
  expect(tl.bars).toHaveLength(1);
  expect(tl.bars[0]?.widthPct).toBeGreaterThan(0);

  const board = parseBoardDocument(
    JSON.stringify({ version: 1, grid: "architectural", viewport: { x: 10, y: 20, zoom: 1.5 }, elements: { a: { id: "a", type: "text", label: "Hi" } } }),
  );
  const entries = boardToNativeEntries("n1", "Board", board, 4);
  expect(entries).toHaveLength(2);

  const html = buildSandboxedHtml(new Map([["structure/index.html", "<!doctype html><html><head></head><body>Hi</body></html>"]]));
  expect(html).toContain("connect-src 'none'");

  expect(formatSummaryValue("2.33333")).toBe("2.33");
  expect(formatSummaryValue("24")).toBe("24");
  expect(parseDateRangeCell("2026-11-23 -> 2026-11-26")).toEqual({ isRange: true, start: "2026-11-23", end: "2026-11-26" });
  expect(formatCompactDateCell("2026-11-23 -> 2026-11-26")).toBe("11/23 → 11/26");
  expect(formatCompactDateCell("2026-12-29 -> 2027-01-03")).toBe("26/12/29 → 27/1/3");
  expect(formatCompactDateCell("2026-11-23")).toBe("2026-11-23");
  expect(cleanWikilinkText("Review [[note:note_123|Spec Doc]] and [[issue:iss_1|#4 Bug]]")).toBe("Review Spec Doc and #4 Bug");
});

test("BaseView switches all 4 views, renders all 12 columns, runs agentAction, and opens Row=Page drawer", async () => {
  setLocale("en");
  const app = await open("./baseViews.story.tsx", {
    width: 1280,
    height: 840,
    colorScheme: "light",
    platform: "macos",
  });

  await app.waitFor("id:note-base-view");
  expect(app.count("id:base-table-view")).toBe(1);
  expect(app.count("id:base-table-summary")).toBe(1);
  expect(app.count("id:base-summary-strip")).toBe(0);
  expect(app.texts()).toContain("Sum: 30");
  expect(app.count("id:base-cell-formula-r1-c_formula")).toBe(1);
  expect(app.texts()).toContain("42");

  // Click noteRef link and issueRef link in Table view.
  await app.press("id:base-cell-note-link-r1-c_note");
  await app.waitFor("text:openNote:note-page-1");

  await app.press("id:base-cell-issue-link-r1-c_issue");
  await app.waitFor("text:openIssue:iss-101");

  // Trigger per-row and header batch agentAction.
  await app.press("id:base-run-row-r1-c_action");
  await app.waitFor("text:run:c_action:r1");

  await app.press("id:base-run-column-c_action");
  await app.waitFor("text:run:c_action:all");

  // Add a row via `+ Add row`.
  await app.press("id:base-add-row");
  await app.waitFor("text:upsert:new");
  expect(app.count("id:base-table-row-r-3")).toBe(1);

  // Switch across Board, Gallery, Timeline, and back to Table.
  await app.press("id:base-view-switcher-board");
  await app.waitFor("id:base-board-view");
  expect(app.texts()).toContain("selectView:sheet1:board");
  expect(app.count("id:base-board-lane-todo")).toBe(1);

  await app.press("id:base-view-switcher-gallery");
  await app.waitFor("id:base-gallery-view");
  expect(app.texts()).toContain("selectView:sheet1:gallery");
  expect(app.count("id:base-gallery-card-r1")).toBe(1);

  await app.press("id:base-view-switcher-timeline");
  await app.waitFor("id:base-timeline-view");
  expect(app.texts()).toContain("selectView:sheet1:timeline");
  expect(app.count("id:base-timeline-row-r1")).toBe(1);

  await app.press("id:base-view-switcher-table");
  await app.waitFor("id:base-table-view");

  // Row = Page drawer: linked row opens existing page; unlinked row creates page.
  await app.press("id:base-row-peek-r1");
  await app.waitFor("id:base-row-drawer");
  expect(app.count("id:base-row-open-page")).toBe(1);
  await app.press("id:base-row-open-page");
  await app.waitFor("text:openNote:note-page-1");

  await app.press("id:base-row-peek-r2");
  await app.waitFor("id:base-row-create-page");
  await app.press("id:base-row-create-page");
  await app.waitFor("text:createPage:r2:note-page-r2");
  await app.waitFor("id:base-row-open-page");
  await app.press("id:base-row-drawer-close");
  await app.waitFor("id:base-table-view");
});

test("CanvasView, MediaView, CollabToolbar, HistoryPanel, and NoteDirectoryView operate over Note APIs", async () => {
  setLocale("en");
  const app = await open("./baseViews.story.tsx", {
    width: 1280,
    height: 840,
    colorScheme: "light",
    platform: "macos",
  });

  // CollabToolbar: presence peer + suggestions popover accept/reject + History panel.
  await app.waitFor("id:note-collab-toolbar");
  expect(app.count("id:collab-peer-agent-arch")).toBe(1);
  await app.press("id:collab-suggestions-toggle");
  await app.waitFor("id:collab-suggestions-popover");
  await app.press("id:collab-suggestion-accept-sug-1");
  await app.waitFor("text:accept:sug-1");

  await app.press("id:collab-toggle-history");
  await app.waitFor("id:note-history-panel");
  await app.waitFor("id:history-commit-1");
  await app.press("id:history-commit-1");
  await app.waitFor("id:history-preview-files");
  await app.press("id:history-close");

  // CanvasView / WhiteboardView (no redundant header or internal seq badge).
  await app.press("id:bench-tab-canvas");
  await app.waitFor("id:note-canvas-view");
  await app.waitFor("id:wb-node-t1");
  expect(app.texts().some((txt) => /^seq \d+$/u.test(txt))).toBe(false);
  await app.press("id:wb-add-node");
  await app.waitFor("text:2 elements");

  // MediaView: audio + transcript + storyboard + motion + assets (no raw data URI or duplicate header).
  await app.press("id:bench-tab-media");
  await app.waitFor("id:note-media-view");
  await app.waitFor("id:media-item-m1");
  await app.waitFor("id:media-transcript-m1");
  expect(app.texts().some((txt) => txt.startsWith("data:"))).toBe(false);
  await app.press("id:media-mode-tabs-storyboard");
  await app.waitFor("id:media-storyboard-panel");
  await app.press("id:media-mode-tabs-motion");
  await app.waitFor("id:media-motion-panel");
  await app.press("id:media-mode-tabs-assets");
  await app.waitFor("id:media-assets-panel");

  // NoteDirectoryView: directory listing & file edit.
  await app.press("id:bench-tab-files");
  await app.waitFor("id:note-directory-view");
  await app.waitFor("id:note-file-row-structure/base.json");
  await app.press("id:note-file-row-manifest.json");
  await app.waitFor("text:manifest.json");
});
