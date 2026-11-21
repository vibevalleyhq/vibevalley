import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { applyBlockOps, flatBlocks, type PkmTreeNode, slugOf, treeOfBlocks } from "./tree";

test("a page's name from its title", () => {
  expect(slugOf(" Cetus Core ")).toBe("cetus-core");
  expect(slugOf("a/b")).toBe("a__b");
  expect(slugOf("a\\b")).toBe("a__b");
});

const node = (id: string, children: PkmTreeNode[] = []): PkmTreeNode => ({ id, depth: 0, body: id, props: {}, children });
let n = 0;
const newId = () => `new-${++n}`;
const blocks = () => applyBlockOps([node("a"), node("b", [node("b1")]), node("c")], [], (f) => f, newId);
const apply = (ops: Parameters<typeof applyBlockOps>[1]) => applyBlockOps(blocks(), ops, (f) => f, newId);
const lines = (nodes: readonly PkmTreeNode[]) =>
  flatBlocks(nodes).map((b) => `${"  ".repeat(b.depth)}${b.marker !== undefined ? `${b.marker} ` : ""}${b.body}`);

test("indents and outdents a block with what is under it", () => {
  expect(lines(apply([{ op: "indent", block: "b" }]))).toEqual(["a", "  b", "    b1", "c"]);
  expect(lines(apply([{ op: "indent", block: "a" }]))).toEqual(["a", "b", "  b1", "c"]);
  expect(lines(apply([{ op: "outdent", block: "b1" }]))).toEqual(["a", "b", "b1", "c"]);
});

test("moves a block with what is under it anywhere, as it is dropped, and never into itself", () => {
  expect(lines(apply([{ op: "move_to", block: "c", target: "a", at: "before" }]))).toEqual(["c", "a", "b", "  b1"]);
  expect(lines(apply([{ op: "move_to", block: "a", target: "b1", at: "after" }]))).toEqual(["b", "  b1", "  a", "c"]);
  expect(lines(apply([{ op: "move_to", block: "b", target: "c", at: "inside" }]))).toEqual(["a", "c", "  b", "    b1"]);
  expect(lines(apply([{ op: "move_to", block: "c", target: "b", at: "inside" }]))).toEqual(["a", "b", "  c", "  b1"]);
  expect(lines(apply([{ op: "move_to", block: "b", target: "b1", at: "after" }]))).toEqual(["a", "b", "  b1", "c"]);
  expect(lines(apply([{ op: "move_to", block: "b", target: "b", at: "inside" }]))).toEqual(["a", "b", "  b1", "c"]);
  expect(lines(apply([{ op: "move_to", block: "a", target: "nowhere", at: "after" }]))).toEqual(["a", "b", "  b1", "c"]);
});

test("moves, inserts, updates and deletes", () => {
  const ops = [
    { op: "move", block: "c", direction: "up" },
    { op: "insert_after", block: "a", id: "given", body: "after a", marker: "TODO" },
    { op: "insert_child", block: "c", body: "under c" },
    { op: "insert_before", block: "b1", body: "before b1" },
    { op: "update", block: "b", body: "B" },
    { op: "toggle_marker", block: "a" },
    { op: "delete", block: "nowhere" },
    { op: "append", body: "last" },
  ] as const;
  expect(lines(apply(ops))).toEqual(["TODO a", "TODO after a", "c", "  under c", "B", "  before b1", "  b1", "last"]);
});

test("cycles a marker and takes it off", () => {
  const toggled = (times: number) => apply(Array.from({ length: times }, () => ({ op: "toggle_marker", block: "a" }) as const))[0]?.marker;
  expect([toggled(1), toggled(2), toggled(3), toggled(4)]).toEqual(["TODO", "DOING", "DONE", "TODO"]);
  const cleared = apply([
    { op: "set_marker", block: "a", marker: "LATER" },
    { op: "set_marker", block: "a" },
  ]);
  expect(cleared[0]?.marker).toBeUndefined();
});

test("leaves the blocks it was given as they were", () => {
  const given = blocks();
  applyBlockOps(given, [{ op: "delete", block: "a" }], (f) => f, newId);
  expect(lines(given)).toEqual(["a", "b", "  b1", "c"]);
});

test("reads the wire's order back into the same tree, with each block's path", () => {
  const flat = flatBlocks(apply([{ op: "update", block: "b", body: "# B\nmore" }]));
  expect(flat.map((b) => b.path)).toEqual(["", "", "B", ""]);
  expect(flatBlocks(treeOfBlocks(flat))).toEqual(flat);
});
