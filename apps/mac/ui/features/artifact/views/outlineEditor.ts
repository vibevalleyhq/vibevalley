import type { OutlineDocument } from "../html";
import {
  addOutlineSibling,
  deleteOutlineNode,
  type FlatOutlineRow,
  flattenOutline,
  indentOutlineNode,
  outdentOutlineNode,
  updateOutlineText,
} from "./previewModel";

export const OUTLINE_BASE_PADDING_PX = 8;
export const OUTLINE_SLOT_PX = 20;
export const OUTLINE_SLOT_GAP_PX = 4;
export const OUTLINE_INDENT_STEP_PX = OUTLINE_SLOT_PX + OUTLINE_SLOT_GAP_PX;
export const OUTLINE_LINE_HEIGHT_PX = 24;

export type OutlineDirection = "up" | "down";

export interface OutlineRowGeometry {
  readonly paddingLeft: number;
  readonly chevronX: number;
  readonly markerX: number;
  readonly textX: number;
}

export interface VisibleOutlineOptions {
  readonly collapsed?: ReadonlySet<string> | undefined;
  readonly hideDone?: boolean | undefined;
}

export interface OutlineSiblingResult {
  readonly doc: OutlineDocument;
  readonly focusId: string;
}

export interface OutlineDeleteResult {
  readonly doc: OutlineDocument;
  readonly deleted: boolean;
  readonly focusId: string | undefined;
}

export interface OutlineIndentResult {
  readonly doc: OutlineDocument;
  readonly changed: boolean;
  readonly focusId: string;
  readonly collapsed: ReadonlySet<string>;
  readonly expandedParentId: string | undefined;
}

export interface OutlineMoveResult {
  readonly doc: OutlineDocument;
  readonly changed: boolean;
  readonly focusId: string;
}

interface NodeLocation {
  readonly parentId: string | undefined;
  readonly siblings: readonly string[];
  readonly index: number;
}

function findNodeLocation(doc: OutlineDocument, targetId: string): NodeLocation | undefined {
  const rootIndex = doc.rootIds.indexOf(targetId);
  if (rootIndex !== -1) {
    return { parentId: undefined, siblings: doc.rootIds, index: rootIndex };
  }
  for (const node of Object.values(doc.nodes)) {
    const childIndex = node.children.indexOf(targetId);
    if (childIndex !== -1) {
      return { parentId: node.id, siblings: node.children, index: childIndex };
    }
  }
  return undefined;
}

export function outlineRowPaddingLeft(depth: number): number {
  const safeDepth = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0;
  return OUTLINE_BASE_PADDING_PX + safeDepth * OUTLINE_INDENT_STEP_PX;
}

/** Computes horizontal x-offsets so each child level's chevron aligns under its parent's marker slot. */
export function outlineRowGeometry(depth: number): OutlineRowGeometry {
  const paddingLeft = outlineRowPaddingLeft(depth);
  const chevronX = paddingLeft;
  const markerX = chevronX + OUTLINE_SLOT_PX + OUTLINE_SLOT_GAP_PX;
  const textX = markerX + OUTLINE_SLOT_PX + OUTLINE_SLOT_GAP_PX;
  return { paddingLeft, chevronX, markerX, textX };
}

export function visibleOutlineRows(doc: OutlineDocument, options?: VisibleOutlineOptions): FlatOutlineRow[] {
  const all = flattenOutline(doc, options?.collapsed);
  if (options?.hideDone !== true) return all;
  return all.filter((row) => !(row.node.kind === "todo" && row.node.checked === true));
}

export function adjacentOutlineRowId(rows: readonly FlatOutlineRow[], currentId: string, direction: OutlineDirection): string | undefined {
  const index = rows.findIndex((row) => row.node.id === currentId);
  if (index === -1) return undefined;
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  return rows[nextIndex]?.node.id;
}

/** Flushes an in-progress draft into `doc`, returning `doc` unchanged by reference when text already matches. */
export function flushOutlineDraftText(doc: OutlineDocument, nodeId: string, draftText: string): OutlineDocument {
  if (!Object.hasOwn(doc.nodes, nodeId)) return doc;
  const existing = doc.nodes[nodeId];
  if (existing.text === draftText) return doc;
  return updateOutlineText(doc, nodeId, draftText);
}

/**
 * Inserts a new sibling after `afterId` and focuses it.
 * Preserves `todo` vs `bullet` kind, while turning Enter on a `heading` into a `bullet` sibling.
 */
export function insertOutlineSibling(doc: OutlineDocument, afterId: string, newId: string, text = ""): OutlineSiblingResult {
  return {
    doc: addOutlineSibling(doc, afterId, newId, text),
    focusId: newId,
  };
}

/**
 * Deletes `nodeId` only when its text is empty (or whitespace-only) and it has no valid children.
 * Refuses cleanly when the node has text or children so subtrees are never destroyed silently.
 * Focuses the previous visible row on deletion, or the next visible row when deleting the first row.
 */
export function deleteEmptyOutlineNode(
  doc: OutlineDocument,
  visibleRows: readonly FlatOutlineRow[],
  nodeId: string,
  currentText?: string,
): OutlineDeleteResult {
  if (!Object.hasOwn(doc.nodes, nodeId)) {
    return { doc, deleted: false, focusId: undefined };
  }
  const node = doc.nodes[nodeId];
  const effectiveText = currentText ?? node.text;
  if (effectiveText.trim() !== "") {
    return { doc, deleted: false, focusId: nodeId };
  }
  const hasValidChildren = node.children.some((childId) => Object.hasOwn(doc.nodes, childId));
  if (hasValidChildren) {
    return { doc, deleted: false, focusId: nodeId };
  }
  const index = visibleRows.findIndex((row) => row.node.id === nodeId);
  const focusId = index > 0 ? visibleRows[index - 1]?.node.id : index === 0 ? visibleRows[1]?.node.id : visibleRows[0]?.node.id;
  return {
    doc: deleteOutlineNode(doc, nodeId),
    deleted: true,
    focusId,
  };
}

export function canIndentOutlineNode(doc: OutlineDocument, nodeId: string): boolean {
  if (!Object.hasOwn(doc.nodes, nodeId)) return false;
  const loc = findNodeLocation(doc, nodeId);
  if (!loc || loc.index <= 0) return false;
  const prevSiblingId = loc.siblings[loc.index - 1];
  return prevSiblingId !== undefined && Object.hasOwn(doc.nodes, prevSiblingId);
}

export function canOutdentOutlineNode(doc: OutlineDocument, nodeId: string): boolean {
  if (!Object.hasOwn(doc.nodes, nodeId)) return false;
  const loc = findNodeLocation(doc, nodeId);
  return loc !== undefined && loc.parentId !== undefined && Object.hasOwn(doc.nodes, loc.parentId);
}

/**
 * Indents `nodeId` under its previous sibling while preserving edit focus.
 * Uncollapses the new parent when it was collapsed (or returns its id in `expandedParentId` when `collapsed` is omitted) so the edited node never disappears.
 */
export function indentOutlineWithFocus(doc: OutlineDocument, nodeId: string, collapsed?: ReadonlySet<string>): OutlineIndentResult {
  const currentCollapsed = collapsed ?? new Set<string>();
  if (!Object.hasOwn(doc.nodes, nodeId)) {
    return { doc, changed: false, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: undefined };
  }
  const loc = findNodeLocation(doc, nodeId);
  if (!loc || loc.index <= 0) {
    return { doc, changed: false, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: undefined };
  }
  const prevSiblingId = loc.siblings[loc.index - 1];
  if (prevSiblingId === undefined || !Object.hasOwn(doc.nodes, prevSiblingId)) {
    return { doc, changed: false, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: undefined };
  }
  const nextDoc = indentOutlineNode(doc, nodeId);
  if (nextDoc === doc) {
    return { doc, changed: false, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: undefined };
  }
  if (collapsed === undefined) {
    return { doc: nextDoc, changed: true, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: prevSiblingId };
  }
  if (collapsed.has(prevSiblingId)) {
    const nextCollapsed = new Set(collapsed);
    nextCollapsed.delete(prevSiblingId);
    return { doc: nextDoc, changed: true, focusId: nodeId, collapsed: nextCollapsed, expandedParentId: prevSiblingId };
  }
  return { doc: nextDoc, changed: true, focusId: nodeId, collapsed, expandedParentId: undefined };
}

/** Outdents `nodeId` to become a sibling after its parent while preserving edit focus. */
export function outdentOutlineWithFocus(doc: OutlineDocument, nodeId: string, collapsed?: ReadonlySet<string>): OutlineIndentResult {
  const currentCollapsed = collapsed ?? new Set<string>();
  if (!Object.hasOwn(doc.nodes, nodeId)) {
    return { doc, changed: false, focusId: nodeId, collapsed: currentCollapsed, expandedParentId: undefined };
  }
  const nextDoc = outdentOutlineNode(doc, nodeId);
  return {
    doc: nextDoc,
    changed: nextDoc !== doc,
    focusId: nodeId,
    collapsed: currentCollapsed,
    expandedParentId: undefined,
  };
}

/** Swaps `nodeId` (along with its subtree) with its previous or next sibling under the same parent. */
export function moveOutlineNodeVertical(doc: OutlineDocument, nodeId: string, direction: OutlineDirection): OutlineMoveResult {
  if (!Object.hasOwn(doc.nodes, nodeId)) {
    return { doc, changed: false, focusId: nodeId };
  }
  const loc = findNodeLocation(doc, nodeId);
  if (!loc) {
    return { doc, changed: false, focusId: nodeId };
  }
  const targetIndex = direction === "up" ? loc.index - 1 : loc.index + 1;
  if (targetIndex < 0 || targetIndex >= loc.siblings.length) {
    return { doc, changed: false, focusId: nodeId };
  }
  const targetId = loc.siblings[targetIndex];
  if (targetId === undefined) {
    return { doc, changed: false, focusId: nodeId };
  }
  const nextSiblings = [...loc.siblings];
  nextSiblings[loc.index] = targetId;
  nextSiblings[targetIndex] = nodeId;

  if (loc.parentId === undefined) {
    return {
      doc: { ...doc, rootIds: nextSiblings },
      changed: true,
      focusId: nodeId,
    };
  }
  if (!Object.hasOwn(doc.nodes, loc.parentId)) {
    return { doc, changed: false, focusId: nodeId };
  }
  const parent = doc.nodes[loc.parentId];
  return {
    doc: {
      ...doc,
      nodes: {
        ...doc.nodes,
        [loc.parentId]: { ...parent, children: nextSiblings },
      },
    },
    changed: true,
    focusId: nodeId,
  };
}
