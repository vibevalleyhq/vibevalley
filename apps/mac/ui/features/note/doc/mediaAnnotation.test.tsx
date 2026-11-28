import "../../../infra/polyfill";
import { describe, expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { DocBlock, MediaAnnotation } from "@vibevalley/protocol";

import { createDefaultBlock, insertTableColumnAt, insertTableRowAt, moveTableColumn, moveTableRow, nextTableCellTarget } from "./docOps";
import {
  buildDocAnnotationIndex,
  clampNormalizedRect,
  computeContainedImageFrame,
  filterVisibleAnnotations,
  nextAnnotationNumber,
  normalizedRectToPixels,
  popoverPositionForRect,
  rectFromDragPoints,
  severityVisualOf,
  translateNormalizedRect,
} from "./mediaAnnotationModel";

describe("mediaAnnotationModel: normalized geometry, Retina containment, and doc index", () => {
  test("computes object-contain image frame and aligns normalized rects across 1x/2x and letterboxing", () => {
    const wideFrame = computeContainedImageFrame(800, 400, 400, 400);
    expect(wideFrame).toEqual({ offsetX: 200, offsetY: 0, width: 400, height: 400 });

    const tallFrame = computeContainedImageFrame(400, 600, 800, 400);
    expect(tallFrame).toEqual({ offsetX: 0, offsetY: 200, width: 400, height: 200 });

    const px = normalizedRectToPixels({ x: 0.25, y: 0.5, w: 0.25, h: 0.25 }, wideFrame);
    expect(px).toEqual({ left: 300, top: 200, width: 100, height: 100 });

    // Retina 2x natural dimensions keep identical rendered sub-box
    const retinaFrame = computeContainedImageFrame(800, 400, 800, 800);
    expect(retinaFrame).toEqual(wideFrame);
  });

  test("clamps rects, converts drag/click gestures, translates, and flips popovers inside viewport", () => {
    expect(clampNormalizedRect({ x: 0.95, y: -0.2, w: 0.2, h: 0.001 })).toEqual({
      x: 0.8,
      y: 0,
      w: 0.2,
      h: 0.025,
    });

    const frame = { offsetX: 100, offsetY: 50, width: 400, height: 200 };
    const clickPin = rectFromDragPoints(300, 150, 302, 151, frame);
    expect(clickPin.w).toBe(0.06);
    expect(clickPin.x).toBe(0.47);

    const dragBox = rectFromDragPoints(140, 70, 300, 170, frame);
    expect(dragBox).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.5 });

    const moved = translateNormalizedRect(dragBox, 40, -10, frame);
    expect(moved).toEqual({ x: 0.2, y: 0.05, w: 0.4, h: 0.5 });

    const rightPop = popoverPositionForRect({ left: 40, top: 40, width: 80, height: 40 }, 600, 300, 260, 140);
    expect(rightPop.left).toBe(128);
    const flippedLeftPop = popoverPositionForRect({ left: 460, top: 40, width: 80, height: 40 }, 600, 300, 260, 140);
    expect(flippedLeftPop.left).toBe(192);
  });

  test("assigns sequential numbers, filters visibility, resolves severity tokens, and indexes doc blocks", () => {
    const anns: MediaAnnotation[] = [
      { id: "a1", number: 1, rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, severity: "p0", title: "One", status: "open", baseRowId: "r1" },
      { id: "a2", number: 3, rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, severity: "ux", title: "Two", status: "resolved", baseRowId: "r2" },
    ];
    expect(nextAnnotationNumber(anns)).toBe(4);
    expect(filterVisibleAnnotations(anns, false, false).length).toBe(0);
    expect(filterVisibleAnnotations(anns, true, true).map((a) => a.id)).toEqual(["a1"]);
    expect(severityVisualOf("p0").token).toBe("berry");
    expect(severityVisualOf("p1").token).toBe("wheat");
    expect(severityVisualOf("p2").token).toBe("water");
    expect(severityVisualOf("ux").token).toBe("accent");

    const blocks: DocBlock[] = [{ id: "m1", type: "media", mediaKind: "image", src: "a.png", annotations: anns }];
    const idx = buildDocAnnotationIndex(blocks);
    expect(idx.byAnnotationId.get("a1")?.blockId).toBe("m1");
    expect(idx.byBaseRowId.get("r2")?.annotation.number).toBe(3);
  });
});

describe("docOps: Table Block enhanced editing helpers", () => {
  test("supports row/column insert, reorder, and Tab/Shift+Tab/Enter cell navigation", () => {
    let table = createDefaultBlock("table", { id: "tbl" });
    if (table.type !== "table") throw new Error("expected table");
    table = {
      ...table,
      headers: ["A", "B"],
      rows: [
        ["r0c0", "r0c1"],
        ["r1c0", "r1c1"],
      ],
      alignments: ["left", "right"],
    };

    const insRow = insertTableRowAt(table, 1);
    expect(insRow.rows.length).toBe(3);
    expect(insRow.rows[1]).toEqual(["", ""]);

    const movedRow = moveTableRow(table, 0, 1);
    expect(movedRow.rows[0]).toEqual(["r1c0", "r1c1"]);
    expect(movedRow.rows[1]).toEqual(["r0c0", "r0c1"]);

    const insCol = insertTableColumnAt(table, 1);
    expect(insCol.headers.length).toBe(3);
    expect(insCol.rows[0]).toEqual(["r0c0", "", "r0c1"]);

    const movedCol = moveTableColumn(table, 0, 1);
    expect(movedCol.headers).toEqual(["B", "A"]);
    expect(movedCol.alignments).toEqual(["right", "left"]);
    expect(movedCol.rows[0]).toEqual(["r0c1", "r0c0"]);

    expect(nextTableCellTarget(2, 2, 0, 0, "next")).toEqual({ row: 0, col: 1 });
    expect(nextTableCellTarget(2, 2, 0, 1, "next")).toEqual({ row: 1, col: 0 });
    expect(nextTableCellTarget(2, 2, 1, 1, "next")).toEqual({ row: 2, col: 0, addRow: true });
    expect(nextTableCellTarget(2, 2, 1, 0, "prev")).toEqual({ row: 0, col: 1 });
    expect(nextTableCellTarget(2, 2, 0, 0, "prev")).toBeUndefined();
    expect(nextTableCellTarget(2, 2, 0, 1, "down")).toEqual({ row: 1, col: 1 });
    expect(nextTableCellTarget(2, 2, 1, 1, "down")).toEqual({ row: 2, col: 1, addRow: true });
  });
});

describe("Interactive MediaAnnotation overlay, Lightbox, BaseEmbed linkage & Table Block UI", () => {
  test("renders pins, inspects & mutates annotations, opens Lightbox overlay, links BaseEmbed rows, and navigates Table via Tab", async () => {
    setLocale("en");
    const app = await open("./mediaAnnotation.story.tsx", {
      width: 1100,
      height: 860,
      colorScheme: "light",
      platform: "macos",
    });

    // 1. All 3 pins render non-destructively over the image stage.
    expect(app.count("id:media-annot-pin-ann_1")).toBe(1);
    expect(app.count("id:media-annot-pin-ann_2")).toBe(1);
    expect(app.count("id:media-annot-pin-ann_3")).toBe(1);

    // 2. Unresolved-only filter hides resolved pin #3 cleanly.
    await app.press("id:media-annot-unresolved-m_shot");
    await app.waitFor("id:media-annot-pin-ann_3", { state: "gone" });
    await app.press("id:media-annot-unresolved-m_shot");
    await app.waitFor("id:media-annot-pin-ann_3");

    // 3. Clicking a BaseEmbed review checklist row bidirectionally opens the linked annotation popover!
    expect(app.count("id:doc-base-embed-pin-rev_2")).toBe(1);
    await app.press("id:doc-base-embed-row-b_review_embed-rev_2");
    await app.waitFor("id:media-annot-popover-ann_2");

    // 4. Clicking Create Issue inside the popover invokes callback and links the new issue!
    await app.press("id:media-annot-create-issue-ann_2");
    await app.waitFor("text:createdIssue:m_shot:[#2] Header button alignment");
    await app.waitFor("id:media-annot-issue-ann_2");

    // 5. Clicking Resolve marks ann_2 resolved; clicking Edit opens inline editor; clicking Delete removes ann_3.
    await app.press("id:media-annot-resolve-ann_2");
    await app.press("id:media-annot-edit-ann_2");
    await app.waitFor("id:media-annot-title-input-ann_2");
    await app.press("id:media-annot-close-ann_2");
    await app.waitFor("id:media-annot-popover-ann_2", { state: "gone" });

    // 6. Opening Lightbox renders the interactive annotation overlay at zoom.
    await app.press("id:media-annot-zoom-m_shot");
    await app.waitFor("id:lightbox");
    await app.waitFor("id:media-annot-overlay-lb-m_shot");
    await app.press("id:lightbox-close");
    await app.waitFor("id:lightbox", { state: "gone" });

    // 7. Table Block Tab navigation & row/col menu insert.
    await app.press("id:doc-table-cell-t_matrix-0-0");
    await app.waitFor("id:doc-table-cell-input-t_matrix-0-0");
    await app.keyboard.press("tab");
    await app.waitFor("id:doc-table-cell-input-t_matrix-0-1");
    await app.keyboard.press("shift+tab");
    await app.waitFor("id:doc-table-cell-input-t_matrix-0-0");

    await app.press("id:doc-table-row-menu-t_matrix-1");
    await app.waitFor("id:doc-table-ins-row-t_matrix-1");
    await app.press("id:doc-table-ins-row-t_matrix-1");
    await app.waitFor("id:doc-table-cell-input-t_matrix-2-0");
  });
});
