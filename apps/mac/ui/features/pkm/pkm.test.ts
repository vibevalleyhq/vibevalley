import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { dayKey, daysUntil } from "./days";
import { autoPair, commandAction, editAction } from "./editing";
import { fencedCode, headingOf, piecesOf, visibleBlocks, wordDiff } from "./outline";
import { flatBlocks } from "./tree";

test("tokenizes inline view pieces, computes word diffs, and formats journal dates", () => {
  expect(piecesOf("Read [[Engine|the engine]] #pkm")).toEqual([
    { kind: "text", text: "Read " },
    { kind: "link", page: "engine", text: "the engine" },
    { kind: "text", text: " " },
    { kind: "tag", page: "pkm", text: "#pkm" },
  ]);
  expect(wordDiff("old text", "new text")).toEqual([
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
    { kind: "same", text: " text" },
  ]);
  const flat = flatBlocks([
    { id: "b1", depth: 0, body: "parent", props: {}, children: [{ id: "b2", depth: 1, body: "child", props: {}, children: [] }] },
    { id: "b3", depth: 0, body: "sibling", props: {}, children: [] },
  ]);
  expect(visibleBlocks(flat, new Set(["b1"])).map((b) => b.body)).toEqual(["parent", "sibling"]);
  expect(dayKey(new Date(2026, 10, 6).getTime())).toBe("2026-11-06");
  expect(daysUntil("2026-11-10", "2026-11-06")).toBe(4);
});

test("parses inline Markdown pieces, headings, and fenced code blocks", () => {
  expect(headingOf("# Title")).toEqual({ level: 1, prefix: 2 });
  expect(headingOf("## Sub")).toEqual({ level: 2, prefix: 3 });
  expect(headingOf("### Small")).toEqual({ level: 3, prefix: 4 });
  expect(headingOf("#### Too deep")).toBeUndefined();
  expect(headingOf("#tag")).toBeUndefined();

  expect(piecesOf("Use `[[raw]]` with **bold**, *italic*, ~~old~~, [docs](https://vibevalley.dev/docs), https://vibevalley.dev，and 2 * 3 * 4")).toEqual([
    { kind: "text", text: "Use " },
    { kind: "code", text: "[[raw]]" },
    { kind: "text", text: " with " },
    { kind: "bold", text: "bold" },
    { kind: "text", text: ", " },
    { kind: "italic", text: "italic" },
    { kind: "text", text: ", " },
    { kind: "strike", text: "old" },
    { kind: "text", text: ", " },
    { kind: "url", text: "docs", url: "https://vibevalley.dev/docs" },
    { kind: "text", text: ", " },
    { kind: "url", text: "https://vibevalley.dev", url: "https://vibevalley.dev" },
    { kind: "text", text: "，and 2 * 3 * 4" },
  ]);

  expect(fencedCode("plain text")).toBeUndefined();
  expect(fencedCode("```ts\nconst x = 1;")).toBeUndefined();
  expect(fencedCode("```ts\nconst x = 1;\n```")).toEqual([{ kind: "code", lang: "ts", code: "const x = 1;" }]);
  expect(fencedCode("Before\n```rust\nfn main() {}\n```\nAfter")).toEqual([
    { kind: "text", text: "Before" },
    { kind: "code", lang: "rust", code: "fn main() {}" },
    { kind: "text", text: "After" },
  ]);
});

test("auto-pairs wiki links and block refs and keeps Enter inside fenced code blocks", () => {
  expect(autoPair("[", "[[", 2)).toEqual({ value: "[[]]", caret: 2 });
  expect(autoPair("See [", "See [[", 6)).toEqual({ value: "See [[]]", caret: 6 });
  expect(autoPair("(", "((", 2)).toEqual({ value: "(())", caret: 2 });
  expect(autoPair("[word", "[[word", 2)).toBeUndefined();
  expect(autoPair("[[", "[[[", 3)).toBeUndefined();
  expect(autoPair("[[Note]]", "[[Note]]]", 7)).toEqual({ value: "[[Note]]", caret: 7 });
  expect(autoPair("[[Note]]", "[[Note]]]", 8)).toEqual({ value: "[[Note]]", caret: 8 });
  expect(autoPair("[[]]", "[]]", 1)).toEqual({ value: "[", caret: 1 });
  expect(autoPair("(())", "())", 1)).toEqual({ value: "(", caret: 1 });

  const block = { id: "b1", depth: 0, body: "```\nconst a = 1;\n```", props: {}, path: "" };
  const enter = { key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
  const inside = editAction(enter, block, { value: block.body, start: 16, end: 16 }, {}, () => "b2");
  expect(inside).toEqual({
    kind: "ops",
    ops: [{ op: "update", block: "b1", body: "```\nconst a = 1;\n\n```" }],
    focus: { block: "b1", at: 17 },
  });
  const after = editAction(enter, block, { value: block.body, start: block.body.length, end: block.body.length }, {}, () => "b2");
  expect(after).toEqual({
    kind: "ops",
    ops: [{ op: "insert_after", block: "b1", id: "b2", body: "" }],
    focus: { block: "b2", at: 0 },
  });
  const codeCmd = commandAction(
    { id: "b1", depth: 0, body: "/code", props: {}, path: "" },
    { value: "/code", start: 5, end: 5 },
    { kind: "command", query: "code", from: 0 },
    { key: "code", text: "```\n\n```", caretOffset: 4 },
  );
  expect(codeCmd).toEqual({
    kind: "ops",
    ops: [{ op: "update", block: "b1", body: "```\n\n```" }],
    focus: { block: "b1", at: 4 },
  });
});
