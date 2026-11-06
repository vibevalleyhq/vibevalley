import type { PkmBlock, PkmBlockOp } from "@vibevalley/protocol";

import type { Keys } from "./editing.ts";

/** Where a pick started and where it has got to, both blocks shown. */
export interface Picked {
  readonly anchor: string;
  readonly head: string;
}

export function pickedIds(shown: readonly PkmBlock[], p: Picked): string[] {
  const a = shown.findIndex((b) => b.id === p.anchor);
  const h = shown.findIndex((b) => b.id === p.head);
  if (a < 0 || h < 0) return [];
  return shown.slice(Math.min(a, h), Math.max(a, h) + 1).map((b) => b.id);
}

export function stepped(shown: readonly PkmBlock[], id: string, way: "up" | "down"): string {
  const i = shown.findIndex((b) => b.id === id);
  return shown[i + (way === "up" ? -1 : 1)]?.id ?? id;
}

/** What an op moves: each with everything under it, so a picked block under a picked parent is left out. */
function topsOf(blocks: readonly PkmBlock[], ids: readonly string[]): PkmBlock[] {
  const picked = new Set(ids);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const under = (b: PkmBlock): boolean => {
    const parent = b.parent === undefined ? undefined : byId.get(b.parent);
    return parent !== undefined && (picked.has(parent.id) || under(parent));
  };
  return blocks.filter((b) => picked.has(b.id) && !under(b));
}

const siblingOf = (blocks: readonly PkmBlock[], b: PkmBlock, way: "before" | "after") => {
  const i = blocks.indexOf(b);
  return blocks.some((x, j) => x.parent === b.parent && (way === "before" ? j < i : j > i));
};

export type PickAction =
  | { readonly kind: "ops"; readonly ops: PkmBlockOp[]; readonly done?: boolean }
  | { readonly kind: "pick"; readonly picked: Picked }
  | { readonly kind: "open"; readonly block: string }
  | { readonly kind: "unpick" };

/** What a key does to the picked blocks. undefined for one it does nothing with. */
export function pickAction(e: Keys, blocks: readonly PkmBlock[], shown: readonly PkmBlock[], p: Picked): PickAction | undefined {
  const ids = pickedIds(shown, p);
  if (ids.length === 0) return undefined;
  const tops = topsOf(blocks, ids);
  const first = tops[0];
  const last = tops.at(-1);
  const mod = e.metaKey || e.ctrlKey;
  const none: PickAction = { kind: "ops", ops: [] };
  if (e.key === "Escape") return { kind: "unpick" };
  if (e.key === "Enter" && mod) return { kind: "ops", ops: ids.map((block) => ({ op: "toggle_marker", block })) };
  if (e.key === "Enter") return { kind: "open", block: p.head };
  if (e.key === "Backspace" || e.key === "Delete") return { kind: "ops", ops: tops.map((b) => ({ op: "delete", block: b.id })), done: true };
  if (e.key === "Tab" && e.shiftKey) return { kind: "ops", ops: tops.toReversed().map((b) => ({ op: "outdent", block: b.id })) };
  if (e.key === "Tab") return first && siblingOf(blocks, first, "before") ? { kind: "ops", ops: tops.map((b) => ({ op: "indent", block: b.id })) } : none;
  if (e.altKey && e.key === "ArrowUp")
    return first && siblingOf(blocks, first, "before") ? { kind: "ops", ops: tops.map((b) => ({ op: "move", block: b.id, direction: "up" })) } : none;
  if (e.altKey && e.key === "ArrowDown")
    return last && siblingOf(blocks, last, "after")
      ? { kind: "ops", ops: tops.toReversed().map((b) => ({ op: "move", block: b.id, direction: "down" })) }
      : none;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const head = stepped(shown, p.head, e.key === "ArrowUp" ? "up" : "down");
    return { kind: "pick", picked: e.shiftKey ? { anchor: p.anchor, head } : { anchor: head, head } };
  }
  return undefined;
}

/** The picked blocks and everything under them as a Markdown outline, the shallowest at no indent. */
export function outlineText(blocks: readonly PkmBlock[], ids: readonly string[]): string {
  const tops = topsOf(blocks, ids);
  const base = Math.min(...tops.map((b) => b.depth));
  const lines: string[] = [];
  for (const top of tops) {
    const at = blocks.indexOf(top);
    const end = blocks.findIndex((b, j) => j > at && b.depth <= top.depth);
    for (const b of blocks.slice(at, end < 0 ? undefined : end)) {
      const indent = "  ".repeat(b.depth - base);
      const [head = "", ...more] = b.body.split("\n");
      lines.push(`${indent}- ${b.marker ? `${b.marker} ` : ""}${head}`, ...more.map((line) => `${indent}  ${line}`));
    }
  }
  return lines.join("\n");
}

export type DropAt = "before" | "after" | "inside";

/** Where a block dropped on a row goes: the row's upper half is before it. */
export const dropAt = (down: number, indent: number): DropAt => (down < 0.5 ? "before" : indent > 32 ? "inside" : "after");

/** The blocks dragged put at target, in their order. */
export function dropOps(blocks: readonly PkmBlock[], ids: readonly string[], target: string, at: DropAt): PkmBlockOp[] {
  const tops = topsOf(blocks, ids);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const moved = new Set(tops.map((b) => b.id));
  for (let b = byId.get(target); b; b = b.parent === undefined ? undefined : byId.get(b.parent)) if (moved.has(b.id)) return [];
  return tops.map((b, i) => {
    const before = tops[i - 1];
    return before ? { op: "move_to", block: b.id, target: before.id, at: "after" } : { op: "move_to", block: b.id, target, at };
  });
}
