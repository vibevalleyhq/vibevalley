import { describe, expect, it } from "vite-plus/test";

import type { HtmlAnchor } from "@vibevalley/protocol";

import { htmlEdit } from "./edit.ts";

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
