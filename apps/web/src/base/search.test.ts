import { expect, test } from "vite-plus/test";

import { matches, pinyinLoaded, spelled } from "./search";

test("every word of the query is somewhere in the texts, ignoring case", () => {
  expect(matches("dark THEME", ["Theme", "light or dark"])).toBe(true);
  expect(matches("dark size", ["Theme", "light or dark"])).toBe(false);
  expect(matches("key", [undefined, "API Key"])).toBe(true);
});

test("an empty query matches everything", () => {
  expect(matches("  ", [])).toBe(true);
});

test("a Chinese name is found by its pinyin, whole, by initials or both, once the dictionary has loaded", async () => {
  await pinyinLoaded;
  expect(spelled("管家", "gj")).toBe(true);
  expect(spelled("管家", "guanjia")).toBe(true);
  expect(spelled("管家", "guanj")).toBe(true);
  expect(spelled("读书笔记", "bj")).toBe(true);
  expect(spelled("重庆", "cq") && spelled("重庆", "zq")).toBe(true);
  expect(spelled("管家", "gz")).toBe(false);
  // Initials of characters that are not next to each other are not a match.
  expect(spelled("读书笔记", "dj")).toBe(false);
  expect(matches("waiguan", ["外观", "主题"])).toBe(true);
});
