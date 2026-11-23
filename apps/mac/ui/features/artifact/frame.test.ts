// An html artifact's web view page (features/artifact/frame.ts): the policy
// where the page's head starts, the shell's runtime reading the asked slide,
// and what the page says taken only when it is the protocol's.
import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { createFrame, withPolicy, withShellQuery } from "./frame";

test("the policy goes in after <head>, else after the doctype, else first", () => {
  expect(withPolicy("<html><head><title>x</title></head></html>")).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy"/u);
  expect(withPolicy("<!doctype html><p>x</p>")).toMatch(/^<!doctype html><meta http-equiv/u);
  expect(withPolicy("<p>x</p>")).toMatch(/^<meta http-equiv/u);
});

test("the shell's runtime reads the asked slide and stillness in place of location.search", () => {
  const sample = `<!doctype html><html><head></head><body><section>a</section><script>const asked = new URLSearchParams(location.search);</script></body></html>`;
  const slide = withShellQuery(sample, { at: 1, still: true });
  expect(slide).toContain(`<head><meta http-equiv="Content-Security-Policy"`);
  expect(slide).toContain(`new URLSearchParams("at=1&still=1")`);
  const plain = withShellQuery(sample);
  expect(plain).toContain(`new URLSearchParams("")`);
});

test("ready, at and a selection are taken; anything else a page posts is not", () => {
  const frame = createFrame();
  frame.heard(JSON.stringify({ vibevalley: "ready", display: "slides", pages: 3, titles: ["a", "b", "c"], notes: ["", "n", ""] }));
  frame.heard(JSON.stringify({ vibevalley: "at", page: 2 }));
  frame.heard(JSON.stringify({ vibevalley: "selection", anchor: { kind: "text", exact: "两条测试", prefix: "", suffix: "" } }));
  frame.heard("not json");
  frame.heard(JSON.stringify({ vibevalley: "ready", display: "nonsense" }));
  frame.heard(JSON.stringify({ vibevalley: "selection", anchor: { kind: "text", exact: "x".repeat(10_001), prefix: "", suffix: "" } }));
  expect(frame.shown().ready?.pages).toBe(3);
  expect(frame.shown().at?.page).toBe(2);
  expect(frame.picked()?.exact).toBe("两条测试");
});
