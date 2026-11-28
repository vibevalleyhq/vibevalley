import "../../../infra/polyfill";
import type { RichNodeJSON } from "nsh/base";
import { describe, expect, test } from "nsh/test";

import { createVvRefNode, markdownToRichDoc, markdownToRichNodes, richDocToMarkdown, splitRichDocToParagraphMarkdowns } from "./richInlineCodec";

describe("richInlineCodec", () => {
  test("round-trips plain text, empty text, and hardBreaks losslessly", () => {
    const samples = ["", "Hello VibeValley", "Line 1\nLine 2", "First\n\nThird", "中文混排 English 123 与标点，。！"];
    for (const s of samples) {
      const doc = markdownToRichDoc(s);
      expect(doc.type).toBe("doc");
      expect(richDocToMarkdown(doc)).toBe(s);
    }
  });

  test("never produces empty text nodes in ProseMirror output", () => {
    const doc = markdownToRichDoc("a\n\nb");
    const para = doc.content?.[0];
    expect(para?.content?.map((n) => n.type)).toEqual(["text", "hardBreak", "hardBreak", "text"]);
    for (const n of para?.content ?? []) {
      if (n.type === "text") {
        expect((n.text ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  test("round-trips inline marks and links without mangling adjacent runs", () => {
    const samples = [
      "统一 **Block Doc** 与 `bg-page` 及 ~~旧版~~ 和 *斜体*",
      "**bold *nested italic* end**",
      "Read [design doc](https://vibevalley.dev/docs#top) before shipping",
      "Keep **[[note:n1|Spec]]** bold",
    ];
    for (const s of samples) {
      expect(richDocToMarkdown(markdownToRichDoc(s))).toBe(s);
    }
  });

  test("parses vvRef atom nodes for notes, embedded issues, [[#N]], and CJK/slash-delimited #N refs while ignoring URL hashes", () => {
    const input = "Open [[note:n1|Spec]], ![[issue:i2|Bug]], [[#42]], （#54）, #166/#169, and #172、#173 at https://x.dev/#99.";
    const nodes = markdownToRichNodes(input);
    const refs = nodes.filter((n) => n.type === "vvRef");
    expect(refs.map((n) => n.attrs)).toEqual([
      { kind: "note", id: "n1", label: "Spec", embed: false, raw: "[[note:n1|Spec]]" },
      { kind: "issue", id: "i2", label: "Bug", embed: true, raw: "![[issue:i2|Bug]]" },
      { kind: "issueNumber", id: "42", label: "#42", embed: false, raw: "[[#42]]" },
      { kind: "issueNumber", id: "54", label: "#54", embed: false, raw: "#54" },
      { kind: "issueNumber", id: "166", label: "#166", embed: false, raw: "#166" },
      { kind: "issueNumber", id: "169", label: "#169", embed: false, raw: "#169" },
      { kind: "issueNumber", id: "172", label: "#172", embed: false, raw: "#172" },
      { kind: "issueNumber", id: "173", label: "#173", embed: false, raw: "#173" },
    ]);
    expect(richDocToMarkdown({ type: "doc", content: [{ type: "paragraph", content: nodes }] })).toBe(input);
  });

  test("preserves code spans literally without parsing inline links or #N inside backticks", () => {
    const input = "Use `[[note:id|title]]` and `#99` inside **code**.";
    const nodes = markdownToRichNodes(input);
    expect(nodes.some((n) => n.type === "vvRef")).toBe(false);
    expect(richDocToMarkdown(markdownToRichDoc(input))).toBe(input);
  });

  test("serializes freshly constructed vvRef nodes without raw attr", () => {
    const node = createVvRefNode({ kind: "note", id: "n7", label: "Architecture" });
    const doc: RichNodeJSON = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, node] }],
    };
    expect(richDocToMarkdown(doc)).toBe("See [[note:n7|Architecture]]");
  });

  test("splits multi-paragraph ProseMirror docs into block markdown lines cleanly", () => {
    const doc: RichNodeJSON = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "First " },
            { type: "text", text: "para", marks: [{ type: "bold" }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Second line 1" }, { type: "hardBreak" }, { type: "text", text: "Second line 2" }] },
      ],
    };
    expect(splitRichDocToParagraphMarkdowns(doc)).toEqual(["First **para**", "Second line 1\nSecond line 2"]);
    expect(richDocToMarkdown(doc)).toBe("First **para**\nSecond line 1\nSecond line 2");
  });
});
