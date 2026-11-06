import { describe, expect, it } from "vite-plus/test";

import { flatBlocks } from "@vibevalley/protocol/rules";

import { carryIds, edgesOf, outlineOf, parse, print, spansOf, walk } from "./outline.ts";
import { fileOf, tierOfFile, titleOfFile } from "./para.ts";

const page = [
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
  "      - level four",
  "        - level five with a fence",
  "          ```ts",
  "          // not a block, not a link",
  "          - TODO fake task [[Fake Link]]",
  "          fake_prop:: 123",
  "          ```",
  "- Notes linking [[Engineering]] and ((6726f8a1-9b1c-4d2e-8f3a-123456789abc)) #outliner",
  "  a second line of the same block",
  "",
].join("\n");

describe("the outline", () => {
  it("reads a file and writes the same file back", () => {
    const read = parse(page, "01_Repos/Cetus-Core-Engine.md", 0);
    expect(read.title).toBe("Cetus Core Engine");
    expect(read.tier).toBe("repo");
    expect(read.props.status).toBe("active");
    const blocks = flatBlocks(read.blocks);
    expect(blocks.map((b) => b.depth)).toEqual([0, 1, 1, 2, 3, 4, 0]);
    expect(blocks[1]).toMatchObject({ marker: "DONE", priority: "A", body: "Write the round-trip spec", props: { completed: "2026-11-02" } });
    expect(blocks[2]).toMatchObject({ id: "6726f8a1-9b1c-4d2e-8f3a-123456789abc", marker: "DOING", path: "Goals and milestones" });
    expect(blocks[5]!.body).toContain("- TODO fake task [[Fake Link]]");
    expect(blocks[6]!.body).toBe("Notes linking [[Engineering]] and ((6726f8a1-9b1c-4d2e-8f3a-123456789abc)) #outliner\na second line of the same block");
    expect(print(read)).toBe(page);
    expect(print(parse(print(read), read.file, 0))).toBe(page);
  });

  it("writes an id only where the file had one, something refers to it or remarks on it", () => {
    const read = parse("- plain\n- referenced\n- with ==words==^[say it better]\n", "00_Inbox/x.md", 0);
    const [plain, referenced] = read.blocks;
    const out = print(read, new Set([referenced!.id]));
    expect(out).not.toContain(`id:: ${plain!.id}`);
    expect(out).toContain(`id:: ${referenced!.id}`);
    expect(out.match(/id::/gu)).toHaveLength(2);
    expect(spansOf(read.blocks[2]!.body)).toEqual([{ text: "words", remark: "say it better" }]);
  });

  it("finds links, tags and refs outside code only", () => {
    const read = parse(page, "01_Repos/Cetus-Core-Engine.md", 0);
    const edges = edgesOf(read);
    expect(edges.filter((e) => e.kind === "wikilink").map((e) => e.page)).toEqual(["engineering"]);
    expect(edges.filter((e) => e.kind === "tag").map((e) => e.page)).toEqual(["outliner"]);
    expect(edges.filter((e) => e.kind === "block_ref").map((e) => e.target)).toEqual(["6726f8a1-9b1c-4d2e-8f3a-123456789abc"]);
    expect(edges.some((e) => e.page === "fake-link")).toBe(false);
  });

  it("reads a bare - as an empty block, not as more of the block above", () => {
    const read = parse("- LATER call the vet\n-\n  - under the empty one\n", "journals/2026_11_04.md", 0);
    expect(flatBlocks(read.blocks).map((b) => [b.depth, b.body])).toEqual([
      [0, "call the vet"],
      [0, ""],
      [1, "under the empty one"],
    ]);
  });

  it("keeps a folded block folded as Logseq writes it, and an unfolded one's line goes", () => {
    const text = "- parent\n  collapsed:: true\n  - child\n";
    const page = parse(text, "pages/p.md", 0);
    expect(page.blocks[0]?.props).toEqual({ collapsed: "true" });
    expect(print(page)).toBe(text);
    const parent = page.blocks[0]!;
    parent.props.collapsed = "";
    expect(print(page)).toBe("- parent\n  - child\n");
  });

  it("reads a jump of two levels as one", () => {
    const read = parse("- a\n      - b\n", "00_Inbox/x.md", 0);
    expect(flatBlocks(read.blocks).map((b) => b.depth)).toEqual([0, 1]);
  });

  it("keeps the ids of the blocks another editor did not change", () => {
    const was = parse("- one\n- two\n- three\n", "00_Inbox/x.md", 0);
    const ids = walk(was.blocks).map((n) => n.id);
    const now = carryIds(was, parse("- zero\n- one\n- two changed\n- three\n", "00_Inbox/x.md", 1));
    const after = walk(now.blocks);
    expect(after[1]!.id).toBe(ids[0]);
    expect(after[3]!.id).toBe(ids[2]);
    expect(new Set(after.map((n) => n.id)).size).toBe(4);
  });

  it("puts a title in the file it names", () => {
    expect(fileOf("repo", "Cetus Core/Engine")).toBe("01_Repos/Cetus-Core__Engine.md");
    expect(titleOfFile("01_Repos/Cetus-Core__Engine.md")).toBe("Cetus-Core/Engine");
    expect(tierOfFile("04_Archives/a.md")).toBe("archive");
    expect(tierOfFile("elsewhere/a.md")).toBe("inbox");
  });
});

describe("text read as an outline", () => {
  it("a line a block, nested by indentation whatever its width, a leading dash or not, with fresh ids", () => {
    let n = 0;
    const id = () => `id-${++n}`;
    const blocks = outlineOf("    读书\n      - 第一章\n         笔记\n      第二章\n\n    TODO 还书\n", id);
    const shape = (nodes: readonly { body: string; marker?: string; id: string; children: readonly unknown[] }[]): unknown[] =>
      nodes.map((b) => [b.marker ?? "", b.body, shape(b.children as never)]);
    expect(shape(blocks as never)).toEqual([
      [
        "",
        "读书",
        [
          ["", "第一章", [["", "笔记", []]]],
          ["", "第二章", []],
        ],
      ],
      ["TODO", "还书", []],
    ]);
    expect([...walk(blocks)].map((b) => b.id)).toEqual(["id-1", "id-2", "id-3", "id-4", "id-5"]);
    expect(outlineOf(" \n\n", id)).toEqual([]);
  });
});
