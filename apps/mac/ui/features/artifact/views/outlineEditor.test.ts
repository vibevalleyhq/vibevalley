import { describe, expect, test } from "nsh/test";

import type { OutlineDocument } from "../html";
import {
  adjacentOutlineRowId,
  canIndentOutlineNode,
  canOutdentOutlineNode,
  deleteEmptyOutlineNode,
  flushOutlineDraftText,
  indentOutlineWithFocus,
  insertOutlineSibling,
  moveOutlineNodeVertical,
  OUTLINE_BASE_PADDING_PX,
  OUTLINE_INDENT_STEP_PX,
  OUTLINE_LINE_HEIGHT_PX,
  OUTLINE_SLOT_GAP_PX,
  OUTLINE_SLOT_PX,
  outdentOutlineWithFocus,
  outlineRowGeometry,
  outlineRowPaddingLeft,
  visibleOutlineRows,
} from "./outlineEditor";
import { flattenOutline } from "./previewModel";

function sampleDoc(): OutlineDocument {
  return {
    version: 1,
    rootIds: ["h1", "b1", "t1", "t2"],
    nodes: {
      h1: { id: "h1", text: "Plan", kind: "heading", children: [] },
      b1: { id: "b1", text: "Overview", kind: "bullet", children: ["b1a", "b1b"] },
      b1a: { id: "b1a", text: "Child A", kind: "bullet", children: [] },
      b1b: { id: "b1b", text: "Child B", kind: "todo", checked: true, children: [] },
      t1: { id: "t1", text: "Ship API", kind: "todo", checked: true, children: [] },
      t2: { id: "t2", text: "Write tests", kind: "todo", checked: false, children: [] },
    },
  };
}

describe("outline row geometry", () => {
  test("aligns each child level chevron with its parent marker slot and child marker with parent text", () => {
    expect(OUTLINE_BASE_PADDING_PX).toBe(8);
    expect(OUTLINE_SLOT_PX).toBe(20);
    expect(OUTLINE_SLOT_GAP_PX).toBe(4);
    expect(OUTLINE_INDENT_STEP_PX).toBe(24);
    expect(OUTLINE_LINE_HEIGHT_PX).toBe(24);

    const depth0 = outlineRowGeometry(0);
    const depth1 = outlineRowGeometry(1);
    const depth2 = outlineRowGeometry(2);

    expect(depth0).toEqual({ paddingLeft: 8, chevronX: 8, markerX: 32, textX: 56 });
    expect(depth1.chevronX).toBe(depth0.markerX);
    expect(depth1.markerX).toBe(depth0.textX);
    expect(depth2.chevronX).toBe(depth1.markerX);
    expect(depth2.markerX).toBe(depth1.textX);
  });

  test("clamps negative or non-finite depths safely to 0", () => {
    expect(outlineRowPaddingLeft(-3)).toBe(OUTLINE_BASE_PADDING_PX);
    expect(outlineRowPaddingLeft(Number.NaN)).toBe(OUTLINE_BASE_PADDING_PX);
    expect(outlineRowPaddingLeft(1.9)).toBe(OUTLINE_BASE_PADDING_PX + OUTLINE_INDENT_STEP_PX);
  });
});

describe("visibleOutlineRows and adjacentOutlineRowId", () => {
  test("navigates up and down across visible rows while respecting collapsed subtrees and hideDone", () => {
    const doc = sampleDoc();
    const allRows = visibleOutlineRows(doc);
    expect(allRows.map((r) => r.node.id)).toEqual(["h1", "b1", "b1a", "b1b", "t1", "t2"]);

    expect(adjacentOutlineRowId(allRows, "h1", "up")).toBeUndefined();
    expect(adjacentOutlineRowId(allRows, "h1", "down")).toBe("b1");
    expect(adjacentOutlineRowId(allRows, "b1", "down")).toBe("b1a");
    expect(adjacentOutlineRowId(allRows, "t2", "down")).toBeUndefined();
    expect(adjacentOutlineRowId(allRows, "t2", "up")).toBe("t1");
    expect(adjacentOutlineRowId(allRows, "missing", "down")).toBeUndefined();

    const collapsedRows = visibleOutlineRows(doc, { collapsed: new Set(["b1"]) });
    expect(collapsedRows.map((r) => r.node.id)).toEqual(["h1", "b1", "t1", "t2"]);
    expect(adjacentOutlineRowId(collapsedRows, "b1", "down")).toBe("t1");
    expect(adjacentOutlineRowId(collapsedRows, "t1", "up")).toBe("b1");

    const hideDoneRows = visibleOutlineRows(doc, { hideDone: true });
    expect(hideDoneRows.map((r) => r.node.id)).toEqual(["h1", "b1", "b1a", "t2"]);
    expect(adjacentOutlineRowId(hideDoneRows, "b1a", "down")).toBe("t2");
    expect(adjacentOutlineRowId(hideDoneRows, "t2", "up")).toBe("b1a");

    const bothRows = visibleOutlineRows(doc, { collapsed: new Set(["b1"]), hideDone: true });
    expect(bothRows.map((r) => r.node.id)).toEqual(["h1", "b1", "t2"]);
    expect(adjacentOutlineRowId(bothRows, "b1", "down")).toBe("t2");
    expect(adjacentOutlineRowId(bothRows, "t2", "up")).toBe("b1");
  });
});

describe("flushOutlineDraftText", () => {
  test("preserves reference identity when unchanged and updates multiline drafts cleanly", () => {
    const doc = sampleDoc();
    expect(flushOutlineDraftText(doc, "b1", "Overview")).toBe(doc);
    expect(flushOutlineDraftText(doc, "missing", "Nope")).toBe(doc);

    const updated = flushOutlineDraftText(doc, "b1", "Line 1\nLine 2");
    expect(updated).not.toBe(doc);
    expect(updated.nodes.b1?.text).toBe("Line 1\nLine 2");

    const cleared = flushOutlineDraftText(updated, "b1", "");
    expect(cleared.nodes.b1?.text).toBe("");
  });
});

describe("insertOutlineSibling", () => {
  test("creates a bullet sibling after a heading rather than another heading", () => {
    const doc = sampleDoc();
    const res = insertOutlineSibling(doc, "h1", "n_after_h1");
    expect(res.focusId).toBe("n_after_h1");
    expect(res.doc.rootIds).toEqual(["h1", "n_after_h1", "b1", "t1", "t2"]);
    expect(res.doc.nodes.n_after_h1).toEqual({
      id: "n_after_h1",
      text: "",
      kind: "bullet",
      children: [],
    });
  });

  test("preserves bullet vs todo kind and creates unchecked todos even after a checked todo", () => {
    const doc = sampleDoc();
    const afterBullet = insertOutlineSibling(doc, "b1a", "n_bullet", "Next bullet");
    expect(afterBullet.focusId).toBe("n_bullet");
    expect(afterBullet.doc.nodes.b1?.children).toEqual(["b1a", "n_bullet", "b1b"]);
    expect(afterBullet.doc.nodes.n_bullet?.kind).toBe("bullet");
    expect(afterBullet.doc.nodes.n_bullet?.text).toBe("Next bullet");

    const afterCheckedTodo = insertOutlineSibling(doc, "t1", "n_todo");
    expect(afterCheckedTodo.focusId).toBe("n_todo");
    expect(afterCheckedTodo.doc.rootIds).toEqual(["h1", "b1", "t1", "n_todo", "t2"]);
    expect(afterCheckedTodo.doc.nodes.n_todo).toEqual({
      id: "n_todo",
      text: "",
      kind: "todo",
      checked: false,
      children: [],
    });
  });

  test("appends a root bullet when afterId is not found", () => {
    const doc = sampleDoc();
    const res = insertOutlineSibling(doc, "unknown", "n_fallback");
    expect(res.focusId).toBe("n_fallback");
    expect(res.doc.rootIds.at(-1)).toBe("n_fallback");
    expect(res.doc.nodes.n_fallback?.kind).toBe("bullet");
  });
});

describe("deleteEmptyOutlineNode", () => {
  test("deletes an empty leaf node and moves focus to the previous visible row", () => {
    const base = sampleDoc();
    const { doc } = insertOutlineSibling(base, "b1a", "empty_leaf", "");
    const rows = visibleOutlineRows(doc);

    const res = deleteEmptyOutlineNode(doc, rows, "empty_leaf");
    expect(res.deleted).toBe(true);
    expect(res.focusId).toBe("b1a");
    expect(res.doc.nodes.empty_leaf).toBeUndefined();
    expect(res.doc.nodes.b1?.children).toEqual(["b1a", "b1b"]);
  });

  test("moves focus to the next visible row when deleting the first visible row, or undefined when sole row", () => {
    const doc: OutlineDocument = {
      version: 1,
      rootIds: ["first", "second"],
      nodes: {
        first: { id: "first", text: "   ", kind: "bullet", children: [] },
        second: { id: "second", text: "Keep", kind: "bullet", children: [] },
      },
    };
    const res = deleteEmptyOutlineNode(doc, visibleOutlineRows(doc), "first");
    expect(res.deleted).toBe(true);
    expect(res.focusId).toBe("second");
    expect(res.doc.rootIds).toEqual(["second"]);

    const single: OutlineDocument = {
      version: 1,
      rootIds: ["only"],
      nodes: {
        only: { id: "only", text: "", kind: "bullet", children: [] },
      },
    };
    const soleRes = deleteEmptyOutlineNode(single, visibleOutlineRows(single), "only");
    expect(soleRes.deleted).toBe(true);
    expect(soleRes.focusId).toBeUndefined();
    expect(soleRes.doc.rootIds).toEqual([]);
  });

  test("respects collapsed parents and hideDone when picking previous visible row", () => {
    const base = sampleDoc();
    const { doc } = insertOutlineSibling(base, "t1", "empty_after_done", "");
    const collapsed = new Set(["b1"]);
    const rows = visibleOutlineRows(doc, { collapsed, hideDone: true });
    expect(rows.map((r) => r.node.id)).toEqual(["h1", "b1", "empty_after_done", "t2"]);

    const res = deleteEmptyOutlineNode(doc, rows, "empty_after_done");
    expect(res.deleted).toBe(true);
    expect(res.focusId).toBe("b1");
  });

  test("refuses cleanly when node has text or valid children so subtrees are never destroyed", () => {
    const doc: OutlineDocument = {
      version: 1,
      rootIds: ["parent_empty", "non_empty"],
      nodes: {
        parent_empty: { id: "parent_empty", text: "", kind: "bullet", children: ["child"] },
        child: { id: "child", text: "Important child", kind: "bullet", children: [] },
        non_empty: { id: "non_empty", text: "Still has text", kind: "bullet", children: [] },
      },
    };
    const rows = visibleOutlineRows(doc);

    const parentRes = deleteEmptyOutlineNode(doc, rows, "parent_empty");
    expect(parentRes.deleted).toBe(false);
    expect(parentRes.focusId).toBe("parent_empty");
    expect(parentRes.doc).toBe(doc);
    expect(parentRes.doc.nodes.child?.text).toBe("Important child");

    const textRes = deleteEmptyOutlineNode(doc, rows, "non_empty");
    expect(textRes.deleted).toBe(false);
    expect(textRes.focusId).toBe("non_empty");
    expect(textRes.doc).toBe(doc);

    const clearedDraftRes = deleteEmptyOutlineNode(doc, rows, "non_empty", "");
    expect(clearedDraftRes.deleted).toBe(true);
    expect(clearedDraftRes.focusId).toBe("child");
    expect(clearedDraftRes.doc.nodes.non_empty).toBeUndefined();

    const missingRes = deleteEmptyOutlineNode(doc, rows, "ghost");
    expect(missingRes.deleted).toBe(false);
    expect(missingRes.focusId).toBeUndefined();
    expect(missingRes.doc).toBe(doc);
  });

  test("allows deleting an empty node whose only children references are dangling", () => {
    const doc: OutlineDocument = {
      version: 1,
      rootIds: ["a", "b"],
      nodes: {
        a: { id: "a", text: "Keep", kind: "bullet", children: [] },
        b: { id: "b", text: "", kind: "bullet", children: ["missing_child"] },
      },
    };
    const res = deleteEmptyOutlineNode(doc, visibleOutlineRows(doc), "b");
    expect(res.deleted).toBe(true);
    expect(res.focusId).toBe("a");
    expect(res.doc.nodes.b).toBeUndefined();
  });
});

describe("indentOutlineWithFocus and outdentOutlineWithFocus", () => {
  test("indents node under previous sibling, preserves focus, and uncollapses a collapsed new parent", () => {
    const doc = sampleDoc();
    expect(canIndentOutlineNode(doc, "h1")).toBe(false);
    expect(canIndentOutlineNode(doc, "t1")).toBe(true);
    expect(canOutdentOutlineNode(doc, "t1")).toBe(false);
    expect(canOutdentOutlineNode(doc, "b1a")).toBe(true);

    const collapsed = new Set(["b1"]);
    const res = indentOutlineWithFocus(doc, "t1", collapsed);
    expect(res.changed).toBe(true);
    expect(res.focusId).toBe("t1");
    expect(res.expandedParentId).toBe("b1");
    expect(res.collapsed.has("b1")).toBe(false);
    expect(collapsed.has("b1")).toBe(true);
    expect(res.doc.nodes.b1?.children).toEqual(["b1a", "b1b", "t1"]);
    expect(flattenOutline(res.doc, res.collapsed).some((r) => r.node.id === "t1")).toBe(true);

    // When collapsed is already open, expandedParentId is undefined and reference is preserved
    const openSet = new Set<string>();
    const openRes = indentOutlineWithFocus(doc, "t1", openSet);
    expect(openRes.changed).toBe(true);
    expect(openRes.expandedParentId).toBeUndefined();
    expect(openRes.collapsed).toBe(openSet);

    // When collapsed is omitted, expandedParentId reports the new parent id so caller can uncollapse it
    const omittedRes = indentOutlineWithFocus(doc, "t1");
    expect(omittedRes.changed).toBe(true);
    expect(omittedRes.expandedParentId).toBe("b1");
  });

  test("returns changed=false without mutating doc or collapsed when indent or outdent is a no-op", () => {
    const doc = sampleDoc();
    const collapsed = new Set(["b1"]);

    const firstIndent = indentOutlineWithFocus(doc, "h1", collapsed);
    expect(firstIndent.changed).toBe(false);
    expect(firstIndent.focusId).toBe("h1");
    expect(firstIndent.doc).toBe(doc);
    expect(firstIndent.collapsed).toBe(collapsed);
    expect(firstIndent.expandedParentId).toBeUndefined();

    const rootOutdent = outdentOutlineWithFocus(doc, "b1", collapsed);
    expect(rootOutdent.changed).toBe(false);
    expect(rootOutdent.focusId).toBe("b1");
    expect(rootOutdent.doc).toBe(doc);
    expect(rootOutdent.collapsed).toBe(collapsed);
    expect(rootOutdent.expandedParentId).toBeUndefined();
  });

  test("outdents nested node after its parent while preserving focus and subtree", () => {
    const doc = sampleDoc();
    const res = outdentOutlineWithFocus(doc, "b1a");
    expect(res.changed).toBe(true);
    expect(res.focusId).toBe("b1a");
    expect(res.doc.rootIds).toEqual(["h1", "b1", "b1a", "t1", "t2"]);
    expect(res.doc.nodes.b1?.children).toEqual(["b1b"]);
  });
});

describe("moveOutlineNodeVertical", () => {
  test("swaps siblings up and down at root and nested levels while preserving subtrees and focus", () => {
    const doc = sampleDoc();

    const moveRootUp = moveOutlineNodeVertical(doc, "b1", "up");
    expect(moveRootUp.changed).toBe(true);
    expect(moveRootUp.focusId).toBe("b1");
    expect(moveRootUp.doc.rootIds).toEqual(["b1", "h1", "t1", "t2"]);
    expect(moveRootUp.doc.nodes.b1?.children).toEqual(["b1a", "b1b"]);

    const moveChildDown = moveOutlineNodeVertical(doc, "b1a", "down");
    expect(moveChildDown.changed).toBe(true);
    expect(moveChildDown.focusId).toBe("b1a");
    expect(moveChildDown.doc.nodes.b1?.children).toEqual(["b1b", "b1a"]);
  });

  test("is a clean no-op at sibling boundaries or for missing nodes", () => {
    const doc = sampleDoc();

    const topNoop = moveOutlineNodeVertical(doc, "h1", "up");
    expect(topNoop.changed).toBe(false);
    expect(topNoop.doc).toBe(doc);

    const bottomNoop = moveOutlineNodeVertical(doc, "t2", "down");
    expect(bottomNoop.changed).toBe(false);
    expect(bottomNoop.doc).toBe(doc);

    const nestedBottomNoop = moveOutlineNodeVertical(doc, "b1b", "down");
    expect(nestedBottomNoop.changed).toBe(false);
    expect(nestedBottomNoop.doc).toBe(doc);

    const missingNoop = moveOutlineNodeVertical(doc, "missing", "up");
    expect(missingNoop.changed).toBe(false);
    expect(missingNoop.doc).toBe(doc);
  });
});
