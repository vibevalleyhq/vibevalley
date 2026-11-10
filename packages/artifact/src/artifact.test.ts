import { describe, expect, it } from "vite-plus/test";

import { keyBetween } from "@vibevalley/protocol/rules";
import { artifactId, blockId } from "@vibevalley/protocol/schema";

import {
  blocksOfMarkdown,
  codePointOffset,
  editSpans,
  htmlCheck,
  htmlEdit,
  inlineSpans,
  markdownOf,
  markdownShortcut,
  ordered,
  Page,
  selectionOf,
  splitAt,
} from "./index.ts";

describe("@vibevalley/artifact domain engine", () => {
  it("applies block operations, splits spans at code points, and round-trips Markdown", () => {
    const aid = artifactId("00000000-0000-4000-a000-000000000001");
    const b1 = blockId("00000000-0000-4000-a000-000000000011");
    const b2 = blockId("00000000-0000-4000-a000-000000000012");
    const firstKey = keyBetween("", "");
    const page = new Page(aid, "user", 1000, []);

    expect(
      page.apply({
        op: "insert_block",
        block: {
          id: b1,
          orderKey: firstKey,
          type: "heading",
          attrs: { level: 2 },
          text: inlineSpans("Hello **world**"),
        },
      }).status,
    ).toBe("applied");

    expect(
      page.apply({
        op: "insert_block",
        block: {
          id: b2,
          orderKey: keyBetween(firstKey, ""),
          type: "todo",
          attrs: { checked: true },
          text: inlineSpans("Ship `@vibevalley/artifact`"),
        },
      }).status,
    ).toBe("applied");

    const md = markdownOf(ordered([...page.blocks.values()]));
    expect(md).toBe("## Hello **world**\n\n- [x] Ship `@vibevalley/artifact`\n");
    const parsed = blocksOfMarkdown(md);
    expect(parsed.map((b) => [b.type, b.attrs])).toEqual([
      ["heading", { level: 2 }],
      ["todo", { checked: true }],
    ]);

    const [left, right] = splitAt(inlineSpans("😀bold"), 1);
    expect([left[0]?.t, right[0]?.t]).toEqual(["😀", "bold"]);
  });

  it("checks HTML CSP safety, applies anchor edits, and handles editor span shortcuts", () => {
    const html = "<!doctype html><html><body><p>First paragraph</p><iframe src='https://evil.example'></iframe></body></html>";
    const checked = htmlCheck(html);
    expect(checked.refused).toEqual([{ kind: "frame", line: 1, tag: "iframe" }]);

    const edited = htmlEdit("<p>Hello world</p>", { kind: "text", exact: "world", prefix: "Hello ", suffix: "" }, "farm");
    expect(edited).toEqual({ ok: true, source: "<p>Hello farm</p>" });

    expect(selectionOf({ vibevalley: "selection", anchor: { kind: "text", exact: "hi", prefix: "a", suffix: "b" } })).toEqual({
      kind: "text",
      exact: "hi",
      prefix: "a",
      suffix: "b",
    });

    expect(codePointOffset("😀abc", 2)).toBe(1);
    expect(markdownShortcut("### Title")).toEqual({ type: "heading", attrs: { level: 3 }, strip: 4 });
    expect(editSpans([{ t: "hello", marks: { bold: true } }], "hello!")).toEqual([{ t: "hello!", marks: { bold: true } }]);
  });
});
