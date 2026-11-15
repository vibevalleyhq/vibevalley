import { describe, expect, it } from "vite-plus/test";

import { canvasEdit, htmlEdit } from "@vibevalley/artifact/html";
import type { HtmlAnchor } from "@vibevalley/protocol";

const words = (exact: string, prefix = "", suffix = ""): HtmlAnchor => ({ kind: "text", exact, prefix, suffix });
const edited = (source: string, anchor: HtmlAnchor, text: string) => {
  const r = htmlEdit(source, anchor, text);
  return r.ok ? r.source : `refused: ${r.why}`;
};

describe("changing words on an HTML artifact's page", () => {
  it("replaces only the words' bytes; every other byte stays as written", () => {
    const page =
      '<!doctype html>\n<html><head><title>T</title><style>p { color: red }</style></head>\n<body>\n  <p class="x">Hello   brave\n  world</p>\n</body></html>\n';
    expect(edited(page, words("brave", "Hello ", " world"), "bold")).toBe(page.replace("brave", "bold"));
    expect(edited(page, words("Hello brave world"), "Hi")).toBe(page.replace("Hello   brave\n  world", "Hi"));
  });

  it("tells one of several alike apart by the words around it, and refuses when it cannot", () => {
    const page = "<ul><li>apple pie</li><li>apple tart</li></ul>";
    expect(edited(page, words("apple", "", " tart"), "pear")).toBe("<ul><li>apple pie</li><li>pear tart</li></ul>");
    expect(edited(page, words("apple", "pie", ""), "pear")).toBe("<ul><li>apple pie</li><li>pear tart</li></ul>");
    expect(edited(page, words("apple"), "pear")).toMatch(/^refused: .*2/u);
  });

  it("finds words written as character references and writes the new ones escaped", () => {
    const page = "<p>Tom &amp; Jerry &lt;3</p>";
    expect(edited(page, words("Tom & Jerry"), "A <b> & C")).toBe("<p>A &lt;b&gt; &amp; C &lt;3</p>");
    expect(edited("<p>a&nbsp;b 😀 c</p>", words("c", "😀 "), "d")).toBe("<p>a&nbsp;b 😀 d</p>");
  });

  it("does not count a script's text, a style's, an attribute's or a comment's as the page's words", () => {
    const page = '<p title="cat">dog</p><!-- cat --><script>const cat = 1</script><style>.cat{}</style>';
    expect(edited(page, words("cat"), "cow")).toMatch(/^refused: /u);
    expect(edited(page, words("dog"), "cow")).toBe(page.replace(">dog<", ">cow<"));
  });

  it("refuses words that cross an element, and an edit that changes nothing", () => {
    const page = "<p>one <b>two</b> three</p>";
    expect(edited(page, words("one two"), "x")).toMatch(/^refused: /u);
    expect(edited(page, words("two"), "TWO")).toBe("<p>one <b>TWO</b> three</p>");
    expect(edited(page, words("two"), " two ")).toMatch(/^refused: /u);
    expect(edited(page, words("  "), "x")).toMatch(/^refused: /u);
  });
});

describe("patching a canvas artifact's board and layers via edit.ts", () => {
  it("patches <vv-board palette> and <vv-layer> attributes (x, y, flip, hidden, locked, z, text) cleanly", () => {
    const source = [
      '<!doctype html><html><body><vv-assets><svg id="mark"></svg></vv-assets>',
      '<vv-board width="1600" height="1000" palette="workbench">',
      '  <vv-layer id="hero" x="40" y="60" w="300" h="300" z="1" asset="mark"></vv-layer>',
      '  <vv-layer id="headline" x="400" y="80" w="600" h="120" z="2" flip="y" hidden locked><h1>Draft Title</h1></vv-layer>',
      "</vv-board></body></html>",
    ].join("\n");

    const patched = canvasEdit(source, {
      board: { palette: "brutalist-red" },
      layers: [
        { id: "hero", x: 80, y: 110, flip: "x", hidden: true, locked: true, z: 5 },
        { id: "headline", flip: "none", hidden: false, locked: false, z: 9, text: "Final & Ready" },
      ],
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) throw new Error(patched.why);
    expect(patched.source).toContain('<vv-board width="1600" height="1000" palette="brutalist-red">');
    expect(patched.source).toContain('<vv-layer id="hero" x="80" y="110" w="300" h="300" z="5" asset="mark" flip="x" locked hidden></vv-layer>');
    expect(patched.source).toContain('<vv-layer id="headline" x="400" y="80" w="600" h="120" z="9"><h1>Final &amp; Ready</h1></vv-layer>');
    expect(patched.source).toContain('<vv-assets><svg id="mark"></svg></vv-assets>');
  });

  it("refuses edits when <vv-board> or a target layer id is missing", () => {
    const board = '<vv-board width="800" height="600"><vv-layer id="title" x="20" y="20" w="200" h="60"><p>Hi</p></vv-layer></vv-board>';
    expect(canvasEdit("<div>plain page</div>", { layers: [{ id: "title", x: 10 }] }).ok).toBe(false);
    expect(canvasEdit(board, { layers: [{ id: "missing-layer", y: 50 }] }).ok).toBe(false);
  });
});
