import { describe, expect, it } from "vite-plus/test";

import { htmlCheck, htmlProblem } from "./check.ts";

const kinds = (html: string) => htmlCheck(html).refused.map((f) => [f.kind, f.line, "need" in f ? f.need : ""]);

describe("what an HTML artifact may load", () => {
  it("lets through a page that loads only from the list and inlines its pictures", () => {
    const page = [
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
    ].join("\n");
    expect(htmlCheck(page)).toEqual({ refused: [], warned: [] });
    expect(htmlProblem(htmlCheck(page))).toBe("");
  });

  it("refuses a load from anywhere else, by the line it is on and what it is for", () => {
    const page = [
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
    ].join("\n");
    expect(kinds(page)).toEqual([
      ["load", 2, "script"],
      ["load", 3, "script"],
      ["load", 4, "style"],
      ["load", 6, "style"],
      ["load", 7, "inline"],
      ["load", 8, "font"],
      ["load", 10, "inline"],
      ["load", 11, "inline"],
      ["load", 12, "inline"],
      ["load", 13, "script"],
      ["load", 13, "script"],
      ["load", 14, "inline"],
    ]);
  });

  it("refuses a form sent away, a page that moves itself or sets its base, and a page inside it", () => {
    const page = [
      '<meta http-equiv="Refresh" content="0; url=https://example.com">',
      '<base href="https://example.com/">',
      '<form action="https://example.com/collect"><input type=submit formaction="/x"></form>',
      '<iframe src="https://example.com"></iframe><object data="x.pdf"></object>',
      "<template><embed src=x></template>",
      '<form action="#"></form><base target="_blank">',
    ].join("\n");
    expect(kinds(page)).toEqual([
      ["refresh", 1, ""],
      ["base", 2, ""],
      ["form", 3, ""],
      ["form", 3, ""],
      ["frame", 4, ""],
      ["frame", 4, ""],
      ["frame", 5, ""],
    ]);
  });

  it("warns once for each network call a script makes, not for what a comment in CSS says", () => {
    const page = ["<style>/* url(https://example.com/x.png) */</style>", "<script>", "fetch('/a'); fetch('/b')", "new WebSocket('wss://x')", "</script>"].join(
      "\n",
    );
    expect(htmlCheck(page)).toEqual({
      refused: [],
      warned: [
        { line: 3, call: "fetch" },
        { line: 4, call: "WebSocket" },
      ],
    });
  });

  it("says each refusal with its line and the hosts to use, and how many more there are past the first eight", () => {
    const one = htmlProblem(htmlCheck('<script src="https://unpkg.com/react"></script>'));
    expect(one).toContain("https://unpkg.com/react");
    expect(one).toContain("cdn.jsdelivr.net");
    const many = htmlProblem(htmlCheck(Array.from({ length: 10 }, (_, i) => `<img src="https://example.com/${i}.png">`).join("\n")));
    expect(many.split("\n- ")).toHaveLength(9);
    expect(many).toContain("2");
  });
});
