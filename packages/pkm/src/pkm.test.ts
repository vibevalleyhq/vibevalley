import { describe, expect, it } from "vite-plus/test";

import { dayKey, daysUntil, piecesOf, visibleBlocks, wordDiff } from "./index.ts";
import { flatBlocks } from "./outline.ts";

describe("@vibevalley/pkm UI helpers", () => {
  it("tokenizes inline view pieces, computes word diffs, and formats journal dates", () => {
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
});
