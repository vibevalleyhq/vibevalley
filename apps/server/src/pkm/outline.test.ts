import { describe, expect, it } from "vite-plus/test";

import { carryIds, edgesOf, flatten, parse, print, spansOf, walk } from "./outline.ts";
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
    const read = parse(page, "01_Projects/Cetus-Core-Engine.md", 0);
    expect(read.title).toBe("Cetus Core Engine");
    expect(read.tier).toBe("project");
    expect(read.props.status).toBe("active");
    const blocks = flatten(read.blocks);
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
    const read = parse(page, "01_Projects/Cetus-Core-Engine.md", 0);
    const edges = edgesOf(read);
    expect(edges.filter((e) => e.kind === "wikilink").map((e) => e.page)).toEqual(["engineering"]);
    expect(edges.filter((e) => e.kind === "tag").map((e) => e.page)).toEqual(["outliner"]);
    expect(edges.filter((e) => e.kind === "block_ref").map((e) => e.target)).toEqual(["6726f8a1-9b1c-4d2e-8f3a-123456789abc"]);
    expect(edges.some((e) => e.page === "fake-link")).toBe(false);
  });

  it("reads a jump of two levels as one", () => {
    const read = parse("- a\n      - b\n", "00_Inbox/x.md", 0);
    expect(flatten(read.blocks).map((b) => b.depth)).toEqual([0, 1]);
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
    expect(fileOf("project", "Cetus Core/Engine")).toBe("01_Projects/Cetus-Core__Engine.md");
    expect(titleOfFile("01_Projects/Cetus-Core__Engine.md")).toBe("Cetus-Core/Engine");
    expect(tierOfFile("04_Archives/a.md")).toBe("archive");
    expect(tierOfFile("elsewhere/a.md")).toBe("inbox");
  });
});
