import { describe, expect, it } from "vite-plus/test";
import type { Block, BlockAttrs, BlockOp, BlockOpStatus, BlockType, TextSpan } from "@vibevalley/protocol";
import { blocksOfMarkdown, markdownOf, type MdBlock } from "./markdown.ts";
import { keyBetween, validKey } from "@vibevalley/protocol/rules";
import { ordered, Page } from "./ops.ts";
import { normal, plain, runeLen, sameText, splitAt } from "./text.ts";
import { bold, para, sample, span } from "./testing.ts";

const block = (b: Partial<Block> & Pick<Block, "id" | "orderKey" | "type">): Block => ({
  artifactId: "d",
  attrs: {},
  text: [],
  rev: 1,
  updatedBy: "owner",
  updated: 0,
  ...b,
});
const under = (b: Block, parent: string): Block => ({ ...b, parentId: parent });

describe("text", () => {
  // Offsets are code points: 中 is one, 👍 one (two UTF-16 units), 👍🏽 two, é written as e and a combining accent two.
  it.each([
    ["chinese", [span("你好世界")], 2, "你好", "世界"],
    ["emoji", [span("a👍b")], 2, "a👍", "b"],
    ["skin tone", [span("👍🏽x")], 2, "👍🏽", "x"],
    ["combining", [span("e\u0301t")], 2, "e\u0301", "t"],
    ["start", [span("ab")], 0, "", "ab"],
    ["end", [span("ab")], 2, "ab", ""],
    ["across spans", [span("你"), bold("好世"), span("界")], 2, "你好", "世界"],
  ] as const)("splits at code points: %s", (_, text, at, left, right) => {
    const [l, r] = splitAt(text, at);
    expect([plain(l), plain(r)]).toEqual([left, right]);
    expect(runeLen(l) + runeLen(r)).toBe(runeLen(text));
  });

  it("keeps marks across a split, and joins like marks", () => {
    const [l, r] = splitAt([span("你"), bold("好世"), span("界")], 2);
    expect(sameText(l, [span("你"), bold("好")]) && sameText(r, [bold("世"), span("界")])).toBe(true);
    expect(normal([span("a"), span(""), span("b"), bold("c"), bold("d")]).map((s) => s.t)).toEqual(["ab", "cd"]);
  });
});

describe("order keys", () => {
  it("a key between two is between them", () => {
    for (const [a, b] of [
      ["", ""],
      ["", "V"],
      ["V", ""],
      ["V", "W"],
      ["1", "2"],
      ["0V", "1"],
      ["a", "a1"],
      ["Zz", "a"],
      ["az", "b"],
      ["", "01"],
    ] as const) {
      const k = keyBetween(a, b);
      expect(validKey(k) && (a === "" || k > a) && (b === "" || k < b), `${a}..${b} gave ${k}`).toBe(true);
    }
    for (const [a, b] of [
      ["b", "a"],
      ["a", "a"],
      ["a0", ""],
      ["", "a-"],
      ["", "é"],
    ] as const)
      expect(() => keyBetween(a, b)).toThrow();
  });

  // Typing at the end, at the start and always in the same gap keeps the keys in order and short enough.
  it.each([
    ["append", (keys: string[]) => [keys.length, keys.at(-1) ?? "", ""] as const],
    ["prepend", (keys: string[]) => [0, "", keys[0] ?? ""] as const],
    ["same gap", (keys: string[]) => (keys.length < 2 ? ([keys.length, keys.at(-1) ?? "", ""] as const) : ([1, keys[0]!, keys[1]!] as const))],
  ] as const)("keys stay in order: %s", (name, next) => {
    const keys: string[] = [];
    for (let i = 0; i < 500; i++) {
      const [at, a, b] = next(keys);
      keys.splice(at, 0, keyBetween(a, b));
    }
    expect([...keys].sort()).toEqual(keys);
    if (name !== "same gap") expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(12);
  });

  it("two blocks with the same key sort by id", () => {
    const p = new Page("d", "owner", 1, [
      block({ id: "b2", orderKey: "V", type: "paragraph" }),
      block({ id: "b1", orderKey: "V", type: "paragraph" }),
      block({ id: "b0", orderKey: "U", type: "paragraph" }),
    ]);
    expect(p.children("").map((b) => b.id)).toEqual(["b0", "b1", "b2"]);
  });
});

describe("ops", () => {
  const cases: { name: string; blocks: Block[]; history?: Record<string, Record<number, string>>; ops: BlockOp[]; status: BlockOpStatus[]; want: string }[] = [
    { name: "insert", blocks: [para("a", "V", "一")], ops: [{ op: "insert_block", block: para("b", "W", "二") }], status: ["applied"], want: "a=一 b=二" },
    {
      name: "insert refused",
      blocks: [para("a", "V", "一")],
      ops: [
        { op: "insert_block", block: para("a", "W", "重名") },
        { op: "insert_block", block: block({ id: "x", orderKey: "W", type: "table" as BlockType }) },
        { op: "insert_block", block: para("y", "W0", "坏键") },
      ],
      status: ["rejected", "rejected", "rejected"],
      want: "a=一",
    },
    {
      name: "update",
      blocks: [para("a", "V", "一")],
      ops: [{ op: "update_text", blockId: "a", baseRev: 1, text: [span("一二")] }],
      status: ["applied"],
      want: "a=一二",
    },
    {
      name: "stale update, someone else changed the text: conflict, theirs kept",
      blocks: [block({ id: "a", orderKey: "V", type: "paragraph", text: [span("别人的")], rev: 3 })],
      history: { a: { 2: "原来的", 3: "别人的" } },
      ops: [{ op: "update_text", blockId: "a", baseRev: 2, text: [span("我的")] }],
      status: ["conflict"],
      want: "a=别人的",
    },
    {
      name: "stale update, only its attrs changed since: taken",
      blocks: [block({ id: "a", orderKey: "V", type: "todo", text: [span("买菜")], rev: 3, attrs: { checked: true } })],
      history: { a: { 2: "买菜", 3: "买菜" } },
      ops: [{ op: "update_text", blockId: "a", baseRev: 2, text: [span("买菜和米")] }],
      status: ["applied"],
      want: "a=买菜和米",
    },
    {
      name: "split mid-text",
      blocks: [para("a", "V", "你好👍世界")],
      ops: [{ op: "split_block", blockId: "a", baseRev: 1, offset: 3, newBlock: para("b", "W", "") }],
      status: ["applied"],
      want: "a=你好👍 b=世界",
    },
    {
      name: "split against a changed text: split at its end, conflict",
      blocks: [block({ id: "a", orderKey: "V", type: "paragraph", text: [span("改过了")], rev: 2 })],
      history: { a: { 1: "原来", 2: "改过了" } },
      ops: [{ op: "split_block", blockId: "a", baseRev: 1, offset: 1, newBlock: para("b", "W", "") }],
      status: ["conflict"],
      want: "a=改过了 b=",
    },
    {
      name: "split out of range",
      blocks: [para("a", "V", "短")],
      ops: [{ op: "split_block", blockId: "a", baseRev: 1, offset: 5, newBlock: para("b", "W", "") }],
      status: ["rejected"],
      want: "a=短",
    },
    {
      name: "merge: the source's text and children go to the target",
      blocks: [para("a", "V", "前"), para("b", "W", "后"), under(para("c", "V", "子"), "b")],
      ops: [{ op: "merge_blocks", targetId: "a", sourceId: "b" }],
      status: ["applied"],
      want: "a=前后 c=子",
    },
    {
      name: "merge a deleted source: noop",
      blocks: [para("a", "V", "前"), block({ id: "b", orderKey: "W", type: "paragraph", text: [span("后")], rev: 2, deleted: true })],
      ops: [{ op: "merge_blocks", targetId: "a", sourceId: "b" }],
      status: ["noop"],
      want: "a=前",
    },
    {
      name: "delete takes the children; restore brings them back",
      blocks: [para("a", "V", "父"), under(para("b", "V", "子"), "a"), para("c", "W", "旁")],
      ops: [
        { op: "delete_block", blockId: "a" },
        { op: "update_text", blockId: "b", baseRev: 2, text: [span("改删掉的")] },
        { op: "delete_block", blockId: "a" },
      ],
      status: ["applied", "conflict", "noop"],
      want: "c=旁",
    },
    {
      name: "restore",
      blocks: [block({ id: "a", orderKey: "V", type: "paragraph", text: [span("回来")], rev: 2, deleted: true })],
      ops: [{ op: "restore_block", blockId: "a" }],
      status: ["applied"],
      want: "a=回来",
    },
    {
      name: "move: under itself is refused, under a deleted parent goes to its level",
      blocks: [para("a", "V", "一"), under(para("b", "V", "二"), "a"), block({ id: "x", orderKey: "X", type: "paragraph", rev: 2, deleted: true })],
      ops: [
        { op: "move_block", blockId: "a", parentId: "b", orderKey: "V" },
        { op: "move_block", blockId: "b", parentId: "x", orderKey: "U" },
      ],
      status: ["rejected", "applied"],
      want: "b=二 a=一",
    },
    {
      name: "set attrs and type",
      blocks: [block({ id: "a", orderKey: "V", type: "todo", text: [bold("字")], attrs: { checked: false } })],
      ops: [
        { op: "set_attrs", blockId: "a", attrs: { checked: true } },
        { op: "set_attrs", blockId: "a", attrs: {}, unset: ["nope"] },
        { op: "set_type", blockId: "a", type: "code", attrs: { language: "go" } },
        { op: "set_type", blockId: "a", type: "table" as BlockType, attrs: {} },
      ],
      status: ["applied", "rejected", "applied", "rejected"],
      want: "a=字",
    },
    {
      name: "a type without text drops it",
      blocks: [para("a", "V", "---")],
      ops: [{ op: "set_type", blockId: "a", type: "divider", attrs: {} }],
      status: ["applied"],
      want: "a=",
    },
  ];
  it.each(cases)("$name", (c) => {
    const p = new Page("d", "lab", 9, c.blocks);
    p.base = (b, rev) => (c.history?.[b]?.[rev] !== undefined ? [span(c.history[b][rev])] : undefined);
    c.ops.forEach((op, i) => expect(p.apply(op).status, `op ${i} (${op.op})`).toBe(c.status[i]));
    expect(
      ordered([...p.blocks.values()])
        .map((b) => b.id + "=" + plain(b.text))
        .join(" "),
    ).toBe(c.want);
  });

  it("changed blocks carry their rev and writer", () => {
    const p = new Page("d", "lab", 9, [para("a", "V", "你好")]);
    p.apply({ op: "split_block", blockId: "a", baseRev: 1, offset: 1, newBlock: para("b", "W", "") });
    const changed = p.changedBlocks();
    expect(changed.map((b) => [b.rev, b.updatedBy, b.updated])).toEqual([
      [2, "lab", 9],
      [1, "lab", 9],
    ]);
    expect(p.revisions.map((r) => [r.rev, plain(r.spans)])).toEqual([
      [2, "你"],
      [1, "好"],
    ]);
    expect(changed[0]!.text[0]!.marks).toEqual({});
  });

  it("every op the protocol has is handled", () => {
    const ops = [
      "insert_block",
      "update_text",
      "set_attrs",
      "set_type",
      "move_block",
      "delete_block",
      "restore_block",
      "split_block",
      "merge_blocks",
    ] satisfies BlockOp["op"][];
    for (const op of ops)
      expect(
        new Page("d", "owner", 1, []).apply({
          op,
          block: block({ id: "", orderKey: "", type: "" as BlockType }),
          newBlock: block({ id: "", orderKey: "", type: "" as BlockType }),
        } as never).reason ?? "",
      ).not.toMatch(/^不认识的改动/);
  });

  it("code has no marks", () => {
    const p = new Page("d", "owner", 1, []);
    p.apply({ op: "insert_block", block: { ...para("c", "V", ""), type: "code", text: [bold("x := 1")] } });
    expect(p.find("c")!.text).toEqual([{ t: "x := 1", marks: {} }]);
  });
});

/** Lays mdBlocks out as stored blocks: ids b0, b1…, each under the last block one level up. */
function laid(md: readonly MdBlock[]): Block[] {
  const parents: string[] = [];
  const last = new Map<string, string>();
  return md.map((b, i) => {
    parents.length = b.depth;
    const parent = b.depth > 0 ? parents[b.depth - 1]! : "";
    const key = keyBetween(last.get(parent) ?? "", "");
    last.set(parent, key);
    parents.push(`b${i}`);
    return block({ id: `b${i}`, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text });
  });
}

const attrsText = (a: BlockAttrs) => {
  const parts: string[] = [];
  if (a.level !== undefined) parts.push(`level=${a.level}`);
  if (a.checked !== undefined) parts.push(`checked=${a.checked}`);
  for (const [name, v] of [
    ["language", a.language],
    ["src", a.src],
    ["alt", a.alt],
    ["issue", a.issueId],
    ["memory", a.memoryId],
  ] as const)
    if (v !== undefined) parts.push(`${name}=${v}`);
  if (a.width !== undefined) parts.push(`size=${a.width}x${a.height}`);
  return parts.sort().join(",");
};

const spansText = (spans: readonly TextSpan[]) =>
  spans
    .map(
      (s) =>
        JSON.stringify(s.t) +
        (s.marks.bold ? "B" : "") +
        (s.marks.italic ? "I" : "") +
        (s.marks.code ? "C" : "") +
        (s.marks.strike ? "S" : "") +
        (s.marks.link !== undefined ? `L(${s.marks.link})` : ""),
    )
    .join("+");

/** What a block is, without its id and place: its depth, type, attrs and text with marks. */
function shape(bs: readonly Block[]): string {
  const depth = new Map<string, number>();
  return ordered(bs)
    .map((b) => {
      const d = b.parentId !== undefined ? (depth.get(b.parentId) ?? 0) + 1 : 0;
      depth.set(b.id, d);
      return `${d} ${b.type} ${attrsText(b.attrs)} ${spansText(normal(b.text))}`;
    })
    .join("\n");
}

describe("markdown", () => {
  it("Markdown → blocks → Markdown gives the same text back", () => {
    const first = laid(blocksOfMarkdown(sample));
    expect(markdownOf(first)).toBe(sample);
    expect(shape(laid(blocksOfMarkdown(markdownOf(first))))).toBe(shape(first));
    const got = shape(first);
    for (const w of [
      `0 heading level=1 "周报：VibeValley 🌾"`,
      `0 paragraph  "这周把"+"块编辑器"B+"的第一步做完了，"+"顺利"I+" 😀。见 "+"设计"L(https://example.com/a_b)+" 和 "+"artifact.submit"C+"，"+"不用 CRDT"S+"。"`,
      `1 bulleted  "子项：中文、emoji 👍🏽"`,
      `0 todo checked=true "合并段落"`,
      `0 quote  "引用一句\\n第二行"`,
      '0 code language=go "func main() {\\n\\tfmt.Println(\\"**不是粗体**\\")\\n}"',
      `0 image alt=农场,size=640x480,src=https://example.com/farm.png `,
      `0 issue_ref issue=0192f `,
      `0 memory_item memory=m1 "记住：测试用 "+"make check"C`,
      `0 paragraph  "# 不是标题，*也不是* 列表 \\\\ 反斜杠"`,
    ])
      expect(got).toContain(w);
  });

  it("blocks → Markdown → blocks keeps every block, whatever its text holds", () => {
    const link = "https://example.com";
    const input: Block[] = [
      block({
        id: "a",
        orderKey: "V",
        type: "paragraph",
        text: [
          span("前 "),
          { t: "粗斜", marks: { bold: true, italic: true } },
          { t: "粗", marks: { bold: true } },
          { t: "链接里的`码`", marks: { link, code: true } },
          span(" *星号* _下划线_ [方括号] ~波浪~ 👨‍👩‍👧"),
          span(" doc"),
          { t: "mid", marks: { italic: true } },
          span("word"),
        ],
      }),
      block({ id: "s", orderKey: "VV", type: "paragraph", text: [span("artifact_block_create 和 artifact_block_update 是工具名")] }),
      block({ id: "b", orderKey: "W", type: "paragraph", text: [span("- 像列表的段落")] }),
      block({ id: "c", orderKey: "X", type: "bulleted", text: [span("[ ] 像待办的列表")] }),
      block({ id: "d", orderKey: "Y", type: "numbered", text: [span("一")] }),
      block({ id: "e", orderKey: "V", parentId: "d", type: "numbered", text: [span("一点一")] }),
      block({ id: "f", orderKey: "Z", type: "numbered", text: [span("二")] }),
      block({ id: "g", orderKey: "a", type: "heading", attrs: { level: 2 }, text: [span("1. 像编号")] }),
    ];
    expect(shape(laid(blocksOfMarkdown(markdownOf(input))))).toBe(shape(input));
    expect(markdownOf(input)).toContain("1. 一\n  1. 一点一\n2. 二");
  });
});
