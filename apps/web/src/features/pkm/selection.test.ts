import { expect, test } from "vite-plus/test";

import type { PkmBlock } from "@vibevalley/protocol";

import { applied } from "./editing";
import { dropAt, dropOps, outlineText, pickAction, pickedIds, type Picked } from "./selection";

const keys = { key: "", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
const block = (id: string, depth = 0, parent?: string): PkmBlock => ({ id, depth, body: id, props: {}, path: "", ...(parent ? { parent } : {}) });
const blocks = [block("a"), block("b"), block("b1", 1, "b"), block("b2", 1, "b"), block("c")];
const pick = (anchor: string, head = anchor): Picked => ({ anchor, head });
const outline = (bs: readonly PkmBlock[]) => bs.map((b) => `${"  ".repeat(b.depth)}${b.id}`);
const after = (key: Partial<typeof keys>, p: Picked) => {
  const a = pickAction({ ...keys, ...key }, blocks, blocks, p);
  return a?.kind === "ops" ? outline(applied(blocks, a.ops)) : a;
};

test("the blocks picked are the ones shown from where the pick started to where it got", () => {
  expect(pickedIds(blocks, pick("c", "b1"))).toEqual(["b1", "b2", "c"]);
  expect(pickedIds([block("a"), block("b")], pick("a", "b1"))).toEqual([]);
  expect(pickAction({ ...keys, key: "ArrowUp", shiftKey: true }, blocks, blocks, pick("b1"))).toEqual({ kind: "pick", picked: pick("b1", "b") });
  expect(pickAction({ ...keys, key: "ArrowDown" }, blocks, blocks, pick("a", "b"))).toEqual({ kind: "pick", picked: pick("b1") });
  expect(pickAction({ ...keys, key: "ArrowUp" }, blocks, blocks, pick("a"))).toEqual({ kind: "pick", picked: pick("a") });
});

test("a key moves the picked blocks together, each with what is under it, in their order", () => {
  expect(after({ key: "Tab" }, pick("b", "c"))).toEqual(["a", "  b", "    b1", "    b2", "  c"]);
  expect(after({ key: "Tab", shiftKey: true }, pick("b1", "b2"))).toEqual(["a", "b", "b1", "b2", "c"]);
  expect(after({ key: "ArrowDown", altKey: true }, pick("a", "b"))).toEqual(["c", "a", "b", "  b1", "  b2"]);
  expect(after({ key: "ArrowUp", altKey: true }, pick("b", "c"))).toEqual(["b", "  b1", "  b2", "c", "a"]);
  expect(after({ key: "Tab" }, pick("a", "b"))).toEqual(outline(blocks));
  expect(after({ key: "ArrowUp", altKey: true }, pick("a", "b"))).toEqual(outline(blocks));
  expect(after({ key: "Backspace" }, pick("b", "b1"))).toEqual(["a", "c"]);
  expect(pickAction({ ...keys, key: "Backspace" }, blocks, blocks, pick("b"))).toMatchObject({ done: true });
  const toggled = pickAction({ ...keys, key: "Enter", metaKey: true }, blocks, blocks, pick("b", "b1"));
  expect(toggled?.kind === "ops" ? applied(blocks, toggled.ops).map((b) => b.marker) : []).toEqual([undefined, "TODO", "TODO", undefined, undefined]);
  expect(pickAction({ ...keys, key: "Enter" }, blocks, blocks, pick("a", "c"))).toEqual({ kind: "open", block: "c" });
  expect(pickAction({ ...keys, key: "Escape" }, blocks, blocks, pick("a"))).toEqual({ kind: "unpick" });
});

test("what is copied is the picked blocks and what is under them as an outline, shallowest at no indent", () => {
  const written = [{ ...block("b1", 1, "b"), marker: "TODO" as const, body: "first\nsecond line" }, block("b2", 1, "b")];
  expect(outlineText([block("b"), ...written, block("c")], ["b1", "b2"])).toBe("- TODO first\n  second line\n- b2");
  expect(outlineText(blocks, ["b", "b1"])).toBe("- b\n  - b1\n  - b2");
});

test("a drop goes before a row, after it, or inside it as its first child, never into what is dragged", () => {
  expect([dropAt(0.2, 100), dropAt(0.7, 10), dropAt(0.7, 40)]).toEqual(["before", "after", "inside"]);
  expect(outline(applied(blocks, dropOps(blocks, ["c"], "a", "before")))).toEqual(["c", "a", "b", "  b1", "  b2"]);
  expect(outline(applied(blocks, dropOps(blocks, ["a", "b"], "c", "inside")))).toEqual(["c", "  a", "  b", "    b1", "    b2"]);
  expect(outline(applied(blocks, dropOps(blocks, ["b1", "b2"], "a", "after")))).toEqual(["a", "b1", "b2", "b", "c"]);
  expect(dropOps(blocks, ["b"], "b2", "after")).toEqual([]);
  expect(dropOps(blocks, ["b"], "b", "inside")).toEqual([]);
});
