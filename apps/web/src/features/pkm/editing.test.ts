import { describe, expect, test } from "vite-plus/test";

import type { PkmBlock } from "@vibevalley/protocol";

import { applied, commandAction, completed, completionAt, editAction, pasteAction } from "./editing";

const block = (id: string, body = id, depth = 0, parent?: string): PkmBlock => ({ id, depth, body, props: {}, path: "", ...(parent ? { parent } : {}) });
const keys = { key: "", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
const at = (value: string, start = value.length, end = start) => ({ value, start, end });
let n = 0;
const newId = () => `n${++n}`;
const lines = (blocks: readonly PkmBlock[]) => blocks.map((b) => `${"  ".repeat(b.depth)}${b.marker ? `${b.marker} ` : ""}${b.body}`);

describe("keys in a block", () => {
  const a = block("a");
  const page = [a, block("b"), block("b1", "b1", 1, "b"), block("c")];

  test("Enter splits at the caret, after the typed words are kept", () => {
    n = 0;
    const done = editAction({ ...keys, key: "Enter" }, a, at("abXcd", 3), {}, newId);
    expect(done).toEqual({
      kind: "ops",
      ops: [
        { op: "update", block: "a", body: "abX" },
        { op: "insert_after", block: "a", id: "n1", body: "cd" },
      ],
      focus: { block: "n1", at: 0 },
    });
    if (done?.kind === "ops") expect(lines(applied(page, done.ops))).toEqual(["abX", "cd", "b", "  b1", "c"]);
  });

  test("Enter at the start puts an empty block above; at the end of an open parent, a first child", () => {
    n = 0;
    expect(editAction({ ...keys, key: "Enter" }, a, at("a", 0), {}, newId)).toMatchObject({
      ops: [{ op: "insert_before", block: "a", id: "n1", body: "" }],
      focus: { block: "a", at: 0 },
    });
    const b = page[1]!;
    const done = editAction({ ...keys, key: "Enter" }, b, at("b"), { parent: true, firstChild: page[2] }, newId);
    if (done?.kind === "ops") expect(lines(applied(page, done.ops))).toEqual(["a", "b", "  ", "  b1", "c"]);
  });

  test("Backspace at the start: an empty block goes, one with words joins the block above; a parent stays", () => {
    const c = page[3]!;
    expect(editAction({ ...keys, key: "Backspace" }, c, at("", 0), { previous: page[2], parent: false }, newId)).toEqual({
      kind: "ops",
      ops: [{ op: "delete", block: "c" }],
      focus: { block: "b1", at: 2 },
    });
    const joined = editAction({ ...keys, key: "Backspace" }, c, at("c", 0), { previous: page[2], parent: false }, newId);
    if (joined?.kind === "ops") expect(lines(applied(page, joined.ops))).toEqual(["a", "b", "  b1c"]);
    expect(editAction({ ...keys, key: "Backspace" }, page[1]!, at("b", 0), { previous: a, parent: true }, newId)).toBeUndefined();
    expect(editAction({ ...keys, key: "Backspace" }, c, at("c", 1), { previous: page[2], parent: false }, newId)).toBeUndefined();
  });

  test("↑ and ↓ leave the block only from its first and last line", () => {
    expect(editAction({ ...keys, key: "ArrowUp" }, a, at("x\ny", 3), { previous: page[3] }, newId)).toBeUndefined();
    expect(editAction({ ...keys, key: "ArrowUp" }, a, at("x\ny", 1), { previous: page[3] }, newId)).toEqual({
      kind: "ops",
      ops: [{ op: "update", block: "a", body: "x\ny" }],
      focus: { block: "c", at: "end" },
    });
    expect(editAction({ ...keys, key: "ArrowDown" }, a, at("a", 0), { next: page[1] }, newId)).toEqual({ kind: "ops", ops: [], focus: { block: "b", at: 0 } });
  });

  test("Tab, Alt+↑↓ and ⌘Enter keep the caret where it is", () => {
    expect(editAction({ ...keys, key: "Tab", shiftKey: true }, a, at("a", 1), {}, newId)).toEqual({
      kind: "ops",
      ops: [{ op: "outdent", block: "a" }],
      focus: { block: "a", at: 1 },
    });
    expect(editAction({ ...keys, key: "ArrowDown", altKey: true }, a, at("a"), {}, newId)).toMatchObject({ ops: [{ op: "move", direction: "down" }] });
    expect(editAction({ ...keys, key: "Enter", metaKey: true }, a, at("a"), {}, newId)).toMatchObject({ ops: [{ op: "toggle_marker" }] });
    expect(editAction({ ...keys, key: "Escape" }, a, at("a"), {}, newId)).toEqual({ kind: "leave" });
    expect(editAction({ ...keys, key: "ArrowUp", shiftKey: true }, a, { value: "a", start: 0, end: 0 }, {}, newId)).toEqual({ kind: "leave", extend: "up" });
    expect(editAction({ ...keys, key: "ArrowDown", shiftKey: true }, a, at("a"), {}, newId)).toEqual({ kind: "leave", extend: "down" });
    expect(editAction({ ...keys, key: "ArrowUp", shiftKey: true }, a, at("a"), {}, newId)).toBeUndefined();
    expect(editAction({ ...keys, key: "Enter", shiftKey: true }, a, at("a"), {}, newId)).toBeUndefined();
  });
});

test("a pasted list becomes blocks nested by its indent, the rest of the line ending the last", () => {
  n = 0;
  const pasted = pasteAction("- one\n  - two\n    - three\n  - four\n- five", block("a", "xy"), at("xy", 1), newId);
  expect(pasted?.kind).toBe("ops");
  if (pasted?.kind !== "ops") return;
  expect(lines(applied([block("a", "xy")], pasted.ops))).toEqual(["xone", "  two", "    three", "  four", "fivey"]);
  expect(pasted.focus).toEqual({ block: "n4", at: 4 });
  expect(pasteAction("one line", block("a"), at("a"), newId)).toBeUndefined();
});

describe("completion at the caret", () => {
  test("names what is being completed and from where", () => {
    expect(completionAt("see [[Cet", 9)).toEqual({ kind: "page", query: "Cet", from: 4 });
    expect(completionAt("see [[Cetus]] and", 17)).toBeUndefined();
    expect(completionAt("a ((6726", 8)).toEqual({ kind: "block", query: "6726", from: 2 });
    expect(completionAt("tagged #pk", 10)).toEqual({ kind: "tag", query: "pk", from: 7 });
    expect(completionAt("a#b", 3)).toBeUndefined();
    expect(completionAt("/to", 3)).toEqual({ kind: "command", query: "to", from: 0 });
    expect(completionAt("x /to", 5)).toBeUndefined();
  });

  test("a # right after Chinese is a tag being typed; one after a Latin word is not", () => {
    expect(completionAt("今天读了#读", 6)).toEqual({ kind: "tag", query: "读", from: 4 });
    expect(completionAt("「#读", 3)).toEqual({ kind: "tag", query: "读", from: 1 });
    expect(completionAt("C#", 2)).toBeUndefined();
  });

  test("regression: a list closed with Escape (the caret as -1) stays closed", () => {
    expect(completionAt("tagged #pk", -1)).toBeUndefined();
    expect(completionAt("see [[Cet", -1)).toBeUndefined();
  });

  test("writes the choice in without doubling a closer already there", () => {
    expect(completed("see [[Cet]] now", 9, { kind: "page", query: "Cet", from: 4 }, "Cetus Core")).toEqual({ value: "see [[Cetus Core]] now", caret: 18 });
    expect(completed("tagged #pk", 10, { kind: "tag", query: "pk", from: 7 }, "pkm")).toEqual({ value: "tagged #pkm ", caret: 12 });
    expect(completed("a ((67", 6, { kind: "block", query: "67", from: 2 }, "id-1")).toEqual({ value: "a ((id-1))", caret: 10 });
  });

  test("a / command takes its word off and marks the block or writes its text", () => {
    const b = block("a", "");
    const c = { kind: "command", query: "todo", from: 0 } as const;
    expect(commandAction(b, at("/todo"), c, { key: "todo", marker: "TODO" })).toEqual({
      kind: "ops",
      ops: [{ op: "set_marker", block: "a", marker: "TODO" }],
      focus: { block: "a", at: 0 },
    });
    expect(commandAction(b, at("/today"), { ...c, query: "today" }, { key: "today", text: "[[2026_11_04]]" })).toEqual({
      kind: "ops",
      ops: [{ op: "update", block: "a", body: "[[2026_11_04]]" }],
      focus: { block: "a", at: 14 },
    });
  });
});
