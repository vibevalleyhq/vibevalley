import { expect, test } from "vite-plus/test";

import { forcedSelector, splitSelectors } from "./pseudo";

test("a selector list splits at its own commas only", () => {
  expect(splitSelectors(".a:hover, :is(.b, .c):hover , [x='1,2']")).toEqual([".a:hover", ":is(.b, .c):hover", "[x='1,2']"]);
});

test("a state becomes an ancestor's attribute", () => {
  expect(forcedSelector(".hover\\:bg-hover:hover", "hover")).toBe('[data-pseudo~="hover"] .hover\\:bg-hover');
  expect(forcedSelector(".group-hover\\:flex:is(:where(.group):hover *)", "hover")).toBe('[data-pseudo~="hover"] .group-hover\\:flex:is(:where(.group) *)');
  expect(forcedSelector(".x:enabled:active", "active")).toBe('[data-pseudo~="active"] .x:enabled');
});

test("only the parts that wait on the state are kept", () => {
  expect(forcedSelector(".a, .b:hover", "hover")).toBe('[data-pseudo~="hover"] .b');
  expect(forcedSelector(".a:focus-within", "focus")).toBeUndefined();
  expect(forcedSelector(".a:hover", "focus")).toBeUndefined();
});

test("a bare state applies to what can take the focus, not to every element", () => {
  expect(forcedSelector(":focus-visible", "focus")).toBe('[data-pseudo~="focus"] :is(a[href],button,input,select,textarea,summary,[tabindex])');
});
