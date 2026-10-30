import { expect, test } from "vite-plus/test";

import { matches } from "./search";

test("every word of the query is somewhere in the texts, ignoring case", () => {
  expect(matches("dark THEME", ["Theme", "light or dark"])).toBe(true);
  expect(matches("dark size", ["Theme", "light or dark"])).toBe(false);
  expect(matches("key", [undefined, "API Key"])).toBe(true);
});

test("an empty query matches everything", () => {
  expect(matches("  ", [])).toBe(true);
});
