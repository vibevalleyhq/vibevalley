import { describe, expect, it } from "vite-plus/test";

import { commandAction, editAction } from "./editing.ts";
import {
  autoPair,
  backlinks,
  carryIds,
  dayKey,
  daysUntil,
  edgesOf,
  exportMarkdown,
  fencedCode,
  fileOf,
  headingOf,
  keepLinks,
  outlineOf,
  type Page,
  pageOf,
  parse,
  piecesOf,
  plainOf,
  print,
  radar,
  renameLinks,
  search,
  spansOf,
  summaryOf,
  tierOfFile,
  titleOfFile,
  transclusions,
  type Vault,
  visibleBlocks,
  walk,
  wordDiff,
} from "./index.ts";
import { flatBlocks } from "./outline.ts";

const samplePage = [
  "title:: Cetus Core Engine",
  "status:: active",
  "area:: [[Engineering]]",
  "deadline:: 2026-11-15",
  "tags:: [[DeepSeek Harness]], #pkm",
  "tldr:: An outline engine on files",
  "",
  "- ## Goals and milestones",
  "  - DONE [#A] Write the round-trip spec",
  "    completed:: 2026-11-02",
  "  - DOING [#B] A one-pass parser",
  "    id:: 6726f8a1-9b1c-4d2e-8f3a-123456789abc",
  "    - level three",
  "- Notes linking [[Engineering]] and ((6726f8a1-9b1c-4d2e-8f3a-123456789abc)) #outliner",
  "",
].join("\n");

describe("@vibevalley/pkm domain engine", () => {
  it("parses and prints Logseq-flavoured Markdown round-trip and extracts edges and spans", () => {
    const read = parse(samplePage, "01_Projects/Cetus-Core-Engine.md", 0);
    expect(read.title).toBe("Cetus Core Engine");
    expect(read.tier).toBe("project");
    expect(print(read)).toBe(samplePage);
    const edges = edgesOf(read);
    expect(edges.filter((e) => e.kind === "wikilink").map((e) => e.page)).toEqual(["engineering"]);
    expect(edges.filter((e) => e.kind === "tag").map((e) => e.page)).toEqual(["outliner"]);
    expect(spansOf("with ==words==^[say it better]")).toEqual([{ text: "words", remark: "say it better" }]);
    expect(fileOf("project", "Cetus Core/Engine")).toBe("01_Projects/Cetus-Core__Engine.md");
    expect(titleOfFile("01_Projects/Cetus-Core__Engine.md")).toBe("Cetus-Core/Engine");
    expect(tierOfFile("04_Archives/a.md")).toBe("archive");
  });

  it("preserves block ids across external edits and builds outlines from raw indented text", () => {
    const was = parse("- one\n- two\n- three\n", "00_Inbox/x.md", 0);
    const ids = walk(was.blocks).map((n) => n.id);
    const now = carryIds(was, parse("- zero\n- one\n- two changed\n- three\n", "00_Inbox/x.md", 1));
    const after = walk(now.blocks);
    expect(after[1]?.id).toBe(ids[0]);
    expect(after[3]?.id).toBe(ids[2]);

    let seq = 0;
    const captured = outlineOf("  Root\n    Child\n", () => `id-${++seq}`);
    expect(walk(captured).map((b) => [b.id, b.depth, b.body])).toEqual([
      ["id-1", 0, "Root"],
      ["id-2", 1, "Child"],
    ]);
  });

  it("resolves vault graph queries, transclusions, backlinks, search, radar, and Markdown export", () => {
    const ref = "aaaaaaaa-0000-4000-a000-000000000001";
    const files: Record<string, string> = {
      "01_Projects/Cetus.md": `alias:: Whale\ndeadline:: 2026-11-15\n\n- TODO ship the parser [[Engine]]\n  deadline:: 2026-11-01\n- the core idea\n  id:: ${ref}\n`,
      "journals/2026_11_03.md": `- met about [[Engine]] and ((${ref}))\n  - its notes\n`,
      "03_Resources/Engine.md": `- what an engine is\n`,
    };
    const nowMs = Date.UTC(2026, 10, 3, 4);
    const vault: Vault = new Map(
      Object.entries(files).map(([file, text]) => {
        const p: Page = parse(text, file, nowMs - 20 * 86_400_000);
        return [p.slug, p];
      }),
    );
    expect(pageOf(vault, "WHALE")?.title).toBe("Cetus");
    const journal = pageOf(vault, "2026_11_03");
    expect(journal).toBeDefined();
    if (journal) {
      expect(summaryOf(journal).day).toBe("2026-11-03");
      expect(transclusions(vault, journal, { circular: (id) => id, broken: (id) => id })).toEqual([
        { block: ref, found: true, circular: false, page: "cetus", pageTitle: "Cetus", body: "the core idea" },
      ]);
      expect(exportMarkdown(vault, journal, (t) => `> ${t}`)).toBe("# 2026_11_03\n\n### met about Engine and the core idea\n\n- its notes\n");
    }
    expect(backlinks(vault, "engine").projects.map((l) => l.body)).toEqual(["ship the parser [[Engine]]"]);
    expect(search(vault, { text: "engine" })[0]?.page).toBe("cetus");
    expect(radar(vault, nowMs, 14).overdue.map((o) => o.body)).toEqual(["ship the parser [[Engine]]"]);
    expect(plainOf(vault, `see [[Engine|the engine]] and ((${ref}))`)).toBe("see the engine and the core idea");
    expect(keepLinks(`see [[A]]`, "see A").text).toBe("see A [[A]]");
    const cetus = pageOf(vault, "cetus");
    expect(cetus && renameLinks(cetus, "engine", "Motor") ? flatBlocks(renameLinks(cetus, "engine", "Motor")!.blocks)[0]?.body : "").toBe(
      "ship the parser [[Motor]]",
    );
  });

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
    const parsed = parse("- parent\n  - child\n- sibling\n", "00_Inbox/x.md", 0);
    const flat = flatBlocks(parsed.blocks);
    expect(visibleBlocks(flat, new Set([flat[0]!.id])).map((b) => b.body)).toEqual(["parent", "sibling"]);
    expect(dayKey(new Date(2026, 10, 6).getTime())).toBe("2026-11-06");
    expect(daysUntil("2026-11-10", "2026-11-06")).toBe(4);
  });

  it("parses inline Markdown pieces, headings, and fenced code blocks", () => {
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

  it("auto-pairs wiki links and block refs and keeps Enter inside fenced code blocks", () => {
    expect(autoPair("[", "[[", 2)).toEqual({ value: "[[]]", caret: 2 });
    expect(autoPair("See [", "See [[", 6)).toEqual({ value: "See [[]]", caret: 6 });
    expect(autoPair("(", "((", 2)).toEqual({ value: "(())", caret: 2 });
    // Does not double-pair before a word or triple bracket.
    expect(autoPair("[word", "[[word", 2)).toBeUndefined();
    expect(autoPair("[[", "[[[", 3)).toBeUndefined();
    // Overtype-skips closing brackets inside an open pair.
    expect(autoPair("[[Note]]", "[[Note]]]", 7)).toEqual({ value: "[[Note]]", caret: 7 });
    expect(autoPair("[[Note]]", "[[Note]]]", 8)).toEqual({ value: "[[Note]]", caret: 8 });
    // Backspace deletes an empty auto-inserted closer.
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
});
