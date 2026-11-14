// Writes vibevalley-artifact's goldens and its shell words from packages/artifact
// (vp run protocol:rust runs it on crates/vibevalley-protocol/gen/prepare.sh's copy).

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const VV = process.argv[2]!;
const out = process.argv[3]!;

const { setLocale } = await import(`${VV}/packages/i18n/src/index.ts`);
setLocale("zh");
const A = await import(`${VV}/packages/artifact/src/index.ts`);
const H = await import(`${VV}/packages/artifact/src/html.ts`);
const Sh = await import(`${VV}/packages/artifact/src/shell.ts`);
const { keyBetween } = await import(`${VV}/packages/protocol/src/rules/index.ts`);
const { sample } = await import("./sample.ts");

const golden = join(out, "tests/golden");
mkdirSync(golden, { recursive: true });
const write = (name: string, v: unknown) => writeFileSync(join(golden, `${name}.json`), JSON.stringify(v, null, 1) + "\n");

// ---- the shell: the words after the page, per display and theme ----
const shell: Record<string, string> = {};
for (const display of ["page", "slides", "motion"]) for (const theme of ["light", "dark"]) shell[`${display}|${theme}`] = Sh.withShell({ page: "", display, theme });
writeFileSync(join(out, "assets/shell.json"), JSON.stringify(shell, null, 1) + "\n");

// ---- Markdown in, blocks, Markdown out ----
const filled = (md: string) => {
  const parents: string[] = [];
  const last = new Map<string, string>();
  let n = 0;
  return A.blocksOfMarkdown(md).map((b: any) => {
    parents.length = b.depth;
    const parent = b.depth > 0 ? parents[b.depth - 1] : undefined;
    const key = keyBetween(last.get(parent ?? "") ?? "", "");
    last.set(parent ?? "", key);
    const id = `b${++n}`;
    parents.push(id);
    return { id, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text, artifactId: "d", rev: 1, updatedBy: "user", updated: 0 };
  });
};
const mds = [
  sample,
  "",
  "plain words\nsecond line\n\nnext paragraph",
  "- a\n  - b\n    - c\n- d\n\n1. x\n2) y\n10. z",
  "> q1\n> q2\n\n> other",
  "```\nno lang\n  indented\n```\n\n```ts\nunclosed",
  "* star item\n+ plus item\n* [ ] todo\n- [X] done",
  "***\n___\n----",
  "![a \\] b](https://x/y.png)\n![](none)",
  "<!-- memory:m2 -->\n<!-- issue:abc -->",
  "    deep para\n  half\nflush",
  "# h1\n## h2\n### h3\n#### h4 is a paragraph",
  "snake_case_word and _italic_ and *star* and **bold _inner_** and ~~gone~~ and [link **b**](u) and `` co`de `` and \\*esc\\*",
  "unclosed **bold and `code and [link]( and _x",
  "a\r\nb\r\n\r\n- c",
  "  - indented first\n- then flush\n    - too deep",
];
write(
  "markdown",
  mds.map((md) => {
    const blocks = filled(md);
    return { md, parsed: A.blocksOfMarkdown(md), blocks, out: A.markdownOf(blocks) };
  }),
);

// Text written as spans, marks the Markdown export must escape.
const spanned = [
  [{ t: "a*b_c`d~e[f]g\\h", marks: {} }],
  [{ t: "word", marks: {} }, { t: "it", marks: { italic: true } }, { t: "word", marks: {} }],
  [{ t: " it ", marks: { italic: true } }],
  [{ t: "x", marks: { bold: true, italic: true, strike: true, link: "https://l" } }],
  [{ t: "a`b", marks: { code: true } }],
  [{ t: "# not heading\n- not list\n 1. space", marks: {} }],
];
write(
  "spans",
  spanned.map((text, i) => {
    const blocks = ["paragraph", "quote", "heading", "code", "todo", "memory_item"].map((type, j) => ({
      id: `s${i}${j}`,
      orderKey: keyBetween(j === 0 ? "" : "V".repeat(j), ""),
      type,
      attrs: type === "heading" ? { level: 5 } : type === "code" ? { language: "rs" } : type === "memory_item" ? { memoryId: "m" } : {},
      text,
      artifactId: "d",
      rev: 1,
      updatedBy: "user",
      updated: 0,
    }));
    return { blocks, out: A.markdownOf(blocks) };
  }),
);

// ---- ops ----
const span = (t: string) => ({ t, marks: {} });
const bold = (t: string) => ({ t, marks: { bold: true } });
const blk = (id: string, orderKey: string, type: string, text: unknown[] = [], more: Record<string, unknown> = {}) => ({
  id,
  artifactId: "d",
  orderKey,
  type,
  attrs: {},
  text,
  rev: 1,
  updatedBy: "user",
  updated: 0,
  ...more,
});
const para = (id: string, key: string, t: string, more: Record<string, unknown> = {}) => blk(id, key, "paragraph", [span(t)], more);
const input = (id: string, orderKey: string, type: string, text: unknown[] = [], more: Record<string, unknown> = {}) => ({ id, orderKey, type, attrs: {}, text, ...more });

const scenarios: { name: string; blocks: unknown[]; history?: Record<string, Record<number, string>>; taken?: string[]; ops: unknown[] }[] = [
  { name: "insert", blocks: [para("a", "V", "一")], ops: [{ op: "insert_block", block: input("b", "W", "paragraph", [span("二"), span("三"), bold("")]) }] },
  {
    name: "insert refused",
    blocks: [para("a", "V", "一")],
    taken: ["t"],
    ops: [
      { op: "insert_block", block: input("a", "W", "paragraph") },
      { op: "insert_block", block: input("y", "W0", "paragraph") },
      { op: "insert_block", block: input("", "W", "paragraph") },
      { op: "insert_block", block: input("t", "W", "paragraph") },
      { op: "insert_block", block: input("p", "W", "paragraph", [], { parentId: "nope" }) },
    ],
  },
  { name: "insert under a deleted parent goes to its live parent", blocks: [para("a", "V", "一"), para("b", "V", "二", { parentId: "a", deleted: true })], ops: [{ op: "insert_block", block: input("c", "V", "code", [bold("x"), span("y")], { parentId: "b" }) }] },
  { name: "update", blocks: [para("a", "V", "一")], ops: [{ op: "update_text", blockId: "a", baseRev: 1, text: [span("一二")] }] },
  { name: "update same text", blocks: [para("a", "V", "一")], ops: [{ op: "update_text", blockId: "a", baseRev: 1, text: [span("一")] }] },
  {
    name: "stale update",
    blocks: [blk("a", "V", "paragraph", [span("别人的")], { rev: 3 })],
    history: { a: { 2: "原来的", 3: "别人的" } },
    ops: [{ op: "update_text", blockId: "a", baseRev: 2, text: [span("我的")] }],
  },
  {
    name: "stale update with the same text as base merges",
    blocks: [blk("a", "V", "paragraph", [span("同")], { rev: 3 })],
    history: { a: { 2: "同" } },
    ops: [{ op: "update_text", blockId: "a", baseRev: 2, text: [span("新")] }],
  },
  {
    name: "update refused",
    blocks: [para("a", "V", "一"), blk("d", "W", "divider"), para("x", "X", "删", { deleted: true })],
    ops: [
      { op: "update_text", blockId: "a", baseRev: 5, text: [] },
      { op: "update_text", blockId: "a", baseRev: 0, text: [] },
      { op: "update_text", blockId: "d", baseRev: 1, text: [] },
      { op: "update_text", blockId: "nope", baseRev: 1, text: [] },
      { op: "update_text", blockId: "x", baseRev: 1, text: [span("迟")] },
    ],
  },
  {
    name: "attrs and type",
    blocks: [blk("h", "V", "heading", [bold("标题")], { attrs: { level: 1 } })],
    ops: [
      { op: "set_attrs", blockId: "h", attrs: { level: 3, alt: "x" }, unset: ["alt"] },
      { op: "set_attrs", blockId: "h", attrs: {}, unset: ["color"] },
      { op: "set_type", blockId: "h", type: "code", attrs: { language: "go" } },
      { op: "set_type", blockId: "h", type: "divider", attrs: {} },
      { op: "set_attrs", blockId: "zz", attrs: {} },
    ],
  },
  {
    name: "delete and restore a subtree",
    blocks: [para("a", "V", "a"), para("b", "V", "b", { parentId: "a" }), para("c", "W", "c", { parentId: "a", deleted: true }), para("d", "V", "d", { parentId: "b" })],
    ops: [
      { op: "delete_block", blockId: "a" },
      { op: "delete_block", blockId: "a" },
      { op: "restore_block", blockId: "b" },
      { op: "restore_block", blockId: "b" },
      { op: "restore_block", blockId: "a" },
      { op: "delete_block", blockId: "nope" },
    ],
  },
  {
    name: "move",
    blocks: [para("a", "V", "a"), para("b", "W", "b"), para("c", "V", "c", { parentId: "b" })],
    ops: [
      { op: "move_block", blockId: "a", parentId: "c", orderKey: "V" },
      { op: "move_block", blockId: "b", parentId: "c", orderKey: "V" },
      { op: "move_block", blockId: "b", parentId: "b", orderKey: "V" },
      { op: "move_block", blockId: "c", orderKey: "X" },
      { op: "move_block", blockId: "c", orderKey: "X0" },
    ],
  },
  {
    name: "split",
    blocks: [blk("a", "V", "paragraph", [span("你"), bold("好世"), span("界")])],
    ops: [
      { op: "split_block", blockId: "a", baseRev: 1, offset: 2, newBlock: input("b", "W", "heading", [span("ignored")]) },
      { op: "split_block", blockId: "a", baseRev: 2, offset: 9, newBlock: input("c", "X", "paragraph") },
      { op: "split_block", blockId: "a", baseRev: 2, offset: 1, newBlock: input("b", "X", "paragraph") },
    ],
  },
  {
    name: "split stale goes to the end",
    blocks: [blk("a", "V", "paragraph", [span("现在的")], { rev: 4 })],
    history: { a: { 2: "以前" } },
    ops: [{ op: "split_block", blockId: "a", baseRev: 2, offset: 1, newBlock: input("b", "W", "code", []) }],
  },
  {
    name: "merge",
    blocks: [
      blk("t", "V", "paragraph", [bold("头")]),
      para("tc", "V", "t's child", { parentId: "t" }),
      blk("s", "W", "paragraph", [bold("尾"), span("巴")]),
      para("s1", "V", "s1", { parentId: "s" }),
      para("s2", "W", "s2", { parentId: "s" }),
    ],
    ops: [
      { op: "merge_blocks", targetId: "t", sourceId: "s" },
      { op: "merge_blocks", targetId: "t", sourceId: "s" },
      { op: "merge_blocks", targetId: "t", sourceId: "t" },
      { op: "merge_blocks", targetId: "x", sourceId: "t" },
    ],
  },
];
write(
  "ops",
  scenarios.map((s) => {
    const p = new A.Page("d", "helper", 5000, s.blocks);
    p.base = (block: string, rev: number) => {
      const t = s.history?.[block]?.[rev];
      return t === undefined ? undefined : [span(t)];
    };
    p.taken = (id: string) => (s.taken ?? []).includes(id);
    const results = s.ops.map((op) => p.apply(op));
    return { ...s, results, after: [...p.blocks.values()].map((b: any) => ({ ...b })), changed: p.changed, revisions: p.revisions, ordered: A.ordered([...p.blocks.values()]) };
  }),
);

// ---- what a page may load ----
const pages = [
  [
    "<!doctype html><html><head>",
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>',
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/x/1/x.css">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
    "<style>@font-face { font-family: X; src: url(https://fonts.gstatic.com/x.woff2) } body { background: url(data:image/png;base64,AA) }</style>",
    '</head><body><img src="data:image/png;base64,AA"><svg><use href="#dot"/></svg>',
    '<form onsubmit="return false"><button>go</button></form><a href="https://example.com" target="_blank">elsewhere</a>',
    "<script type=module>import { a } from 'https://cdn.jsdelivr.net/npm/a/+esm'; a()</script>",
    '<script type="application/json">{"url": "https://example.com/x.png"}</script>',
    "</body></html>",
  ].join("\n"),
  [
    "<html><head>",
    '<script src="https://unpkg.com/react"></script>',
    '<script src="/api/v1/state"></script>',
    '<link rel="stylesheet" href="//cdn.jsdelivr.net.evil.example/x.css">',
    "<style>",
    "  @import url('https://example.com/a.css');",
    "  body { background: url(https://example.com/bg.png) }",
    "  @font-face { src: url('https://example.com/f.woff') }",
    "</style>",
    '</head><body><img srcset="data:image/png;base64,AA 1x, https://example.com/x@2x.png 2x">',
    '<div style="background-image: url(https://example.com/t.gif)"></div>',
    "<video poster=https://example.com/p.jpg></video>",
    "<script type=module>import x from \"https://esm.sh/x\"; import('https://esm.sh/y')</script>",
    '<link rel="icon" href="https://example.com/favicon.ico">',
    "</body></html>",
  ].join("\n"),
  [
    '<meta http-equiv="Refresh" content="0; url=https://example.com">',
    '<base href="https://example.com/">',
    '<form action="https://example.com/collect"><input type=submit formaction="/x"></form>',
    '<iframe src="https://example.com"></iframe><object data="x.pdf"></object>',
    "<template><embed src=x></template>",
    '<form action="#"></form><base target="_blank">',
  ].join("\n"),
  ["<style>/* url(https://example.com/x.png) */</style>", "<script>", "fetch('/a'); fetch('/b')", "new WebSocket('wss://x')", "</script>"].join("\n"),
  '<script src="https://unpkg.com/react"></script>',
  Array.from({ length: 10 }, (_, i) => `<img src="https://example.com/${i}.png">`).join("\n"),
  "<!doctype html><html><body><p>First paragraph</p><iframe src='https://evil.example'></iframe></body></html>",
  '<img\n  alt="x"\n  src="https://example.com/late.png"><input type="IMAGE" src="https://e.x/i.png"><link rel="preload" as="font" href="https://e.x/f"><link rel="modulepreload" href="https://cdn.jsdelivr.net/m.js"><script href="https://e.x/h.js"></script><a href="javascript:void 0"><button formaction="javascript:go()">x</button></a>',
  "<p>just words &amp; more</p>",
];
write(
  "check",
  pages.map((page) => {
    const check = H.htmlCheck(page);
    return { page, check, problem: H.htmlProblem(check) };
  }),
);

// ---- words changed on a page ----
const words = (exact: string, prefix = "", suffix = "") => ({ kind: "text", exact, prefix, suffix });
const doc = '<!doctype html>\n<html><head><title>T</title><style>p { color: red }</style></head>\n<body>\n  <p class="x">Hello   brave\n  world</p>\n</body></html>\n';
const edits: [string, unknown, string][] = [
  [doc, words("brave", "Hello ", " world"), "bold"],
  [doc, words("Hello brave world"), "Hi"],
  ["<ul><li>apple pie</li><li>apple tart</li></ul>", words("apple", "", " tart"), "pear"],
  ["<ul><li>apple pie</li><li>apple tart</li></ul>", words("apple", "pie", ""), "pear"],
  ["<ul><li>apple pie</li><li>apple tart</li></ul>", words("apple"), "pear"],
  ["<p>Tom &amp; Jerry &lt;3</p>", words("Tom & Jerry"), "A <b> & C"],
  ["<p>a&nbsp;b 😀 c</p>", words("c", "😀 "), "d"],
  ['<p title="cat">dog</p><!-- cat --><script>const cat = 1</script><style>.cat{}</style>', words("cat"), "cow"],
  ['<p title="cat">dog</p><!-- cat --><script>const cat = 1</script><style>.cat{}</style>', words("dog"), "cow"],
  ["<p>one <b>two</b> three</p>", words("one two"), "x"],
  ["<p>one <b>two</b> three</p>", words("two"), "TWO"],
  ["<p>one <b>two</b> three</p>", words("two"), " two "],
  ["<p>one <b>two</b> three</p>", words("  "), "x"],
  ["<p>one <b>two</b> three</p>", words("four"), "x"],
  ["<template><p>hidden</p></template><p>shown</p><textarea>area</textarea>", words("hidden"), "x"],
  ["<template><p>hidden</p></template><p>shown</p><textarea>area</textarea>", words("shown"), "x"],
  ["<p>a\n\n   b</p><p>c</p>", words("a b"), "ab"],
];
write(
  "edit",
  edits.map(([source, anchor, text]) => ({ source, anchor, text, result: H.htmlEdit(source, anchor, text) })),
);

write("problem", [
  { title: "", kind: undefined, size: undefined },
  { title: "x".repeat(81), kind: undefined, size: undefined },
  { title: "ok", kind: "pdf", size: 1 },
  { title: "ok", kind: "html", size: 0 },
  { title: "ok", kind: "markdown", size: 6 * 1024 * 1024 },
  { title: "ok", kind: "markdown", size: 6 },
].map((a) => ({ ...a, problem: H.artifactProblem(a) })));
console.log("artifact goldens written");
