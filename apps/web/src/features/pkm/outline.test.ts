import { expect, test } from "vite-plus/test";

import type { PkmBlock, PkmPageSummary } from "@vibevalley/protocol";

import { byTier, hasChildren, piecesOf, visibleBlocks, wordDiff } from "./outline";

const page = (slug: string, tier: PkmPageSummary["tier"]): PkmPageSummary => ({ slug, title: slug, tier, file: `${slug}.md`, tldr: "", updated: 0, open: 0 });
const block = (id: string, depth: number): PkmBlock => ({ id, depth, body: id, props: {}, path: "" });

test("groups pages by tier in PARA order, empty tiers left out", () => {
  const groups = byTier([page("j", "journal"), page("p", "repo"), page("r", "resource")]);
  expect(groups.map((g) => g.tier)).toEqual(["repo", "resource", "journal"]);
});

test("hides the blocks under a collapsed one, not its siblings", () => {
  const blocks = [block("a", 0), block("b", 1), block("c", 2), block("d", 1), block("e", 0)];
  expect(visibleBlocks(blocks, new Set(["b"])).map((b) => b.id)).toEqual(["a", "b", "d", "e"]);
  expect(visibleBlocks(blocks, new Set(["a"])).map((b) => b.id)).toEqual(["a", "e"]);
  expect(hasChildren(blocks, 0)).toBe(true);
  expect(hasChildren(blocks, 3)).toBe(false);
  expect(hasChildren(blocks, 4)).toBe(false);
});

test("reads links, tags and refs out of a block's text", () => {
  expect(piecesOf("see [[Cetus Core|core]] and ((6726f8a1-9b1c-4d2e-8f3a-123456789abc)) #pkm")).toEqual([
    { kind: "text", text: "see " },
    { kind: "link", page: "cetus-core", text: "core" },
    { kind: "text", text: " and " },
    { kind: "ref", id: "6726f8a1-9b1c-4d2e-8f3a-123456789abc" },
    { kind: "text", text: " " },
    { kind: "tag", page: "pkm", text: "#pkm" },
  ]);
  expect(piecesOf("#ui first")).toEqual([
    { kind: "tag", page: "ui", text: "#ui" },
    { kind: "text", text: " first" },
  ]);
  expect(piecesOf("issue#3 is not a tag")).toEqual([{ kind: "text", text: "issue#3 is not a tag" }]);
  expect(piecesOf("今天读了#读书，很好")).toEqual([
    { kind: "text", text: "今天读了" },
    { kind: "tag", page: "读书", text: "#读书" },
    { kind: "text", text: "，很好" },
  ]);
  expect(piecesOf("## 标题 and C# and a.com/#top")).toEqual([{ kind: "text", text: "## 标题 and C# and a.com/#top" }]);
  expect(piecesOf("a ==sharp words==^[💬 too strong] b")).toEqual([
    { kind: "text", text: "a " },
    { kind: "remark", text: "sharp words", remark: "too strong" },
    { kind: "text", text: " b" },
  ]);
});

test("diffs a rewrite word by word, a Han character a word", () => {
  expect(wordDiff("the quick fox", "the slow fox")).toEqual([
    { kind: "same", text: "the " },
    { kind: "del", text: "quick" },
    { kind: "add", text: "slow" },
    { kind: "same", text: " fox" },
  ]);
  expect(wordDiff("深海知识", "深海笔记")).toEqual([
    { kind: "same", text: "深海" },
    { kind: "del", text: "知识" },
    { kind: "add", text: "笔记" },
  ]);
});
