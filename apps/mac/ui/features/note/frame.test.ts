// Sandboxed preview document assembly (features/note/frame.ts): strict CSP
// injection and local CSS/JS inlining without relaxing same-origin or network rules.
import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { buildPrototypeDocument, withPolicy } from "./frame";

test("the policy goes in after <head>, else after the doctype, else first", () => {
  expect(withPolicy("<html><head><title>x</title></head></html>")).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy"/u);
  expect(withPolicy("<!doctype html><p>x</p>")).toMatch(/^<!doctype html><meta http-equiv/u);
  expect(withPolicy("<p>x</p>")).toMatch(/^<meta http-equiv/u);
});

test("buildPrototypeDocument inlines local CSS/JS and enforces strict CSP with connect-src none", () => {
  const files = new Map<string, string>([
    [
      "structure/index.html",
      '<!doctype html><html><head><link rel="stylesheet" href="./styles.css" /></head><body><main id="app">Hi</main><script type="module" src="./app.js"></script></body></html>',
    ],
    ["structure/styles.css", "body { color: #1c1917; }"],
    ["structure/app.js", 'export const ok = "</script>";'],
  ]);
  const doc = buildPrototypeDocument(files);
  expect(doc).toContain(`connect-src 'none'`);
  expect(doc).toContain(`<style>\nbody { color: #1c1917; }\n</style>`);
  expect(doc).toContain(`<script type="module">\nexport const ok = "<\\/script>";\n</script>`);
});

test("buildPrototypeDocument falls back to alternate html entry and inlines local svg images", () => {
  const files = new Map<string, string>([
    ["structure/preview.html", '<!doctype html><html><head></head><body><img alt="icon" src="../asset/logo.svg"></body></html>'],
    ["asset/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'],
  ]);
  const doc = buildPrototypeDocument(files);
  expect(doc).toContain("data:image/svg+xml;charset=utf-8,");
  expect(doc).toContain(`connect-src 'none'`);
});
