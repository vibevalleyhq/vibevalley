// Synchronous search helpers (`base/search.ts`): direct case-insensitive substring matching,
// multi-word filtering, ordering helpers, and clean fallback when native `vibevalley/rich` is absent.
import "../polyfill";
import { expect, test } from "nsh/test";

import { compareText, matches, or, spelled } from "./search";

test("spelled matches ASCII and Hanzi substrings ignoring case and degrades cleanly without native pinyin", () => {
  expect(spelled("VibeValley 工单", "")).toBe(true);
  expect(spelled("VibeValley 工单", "vibe")).toBe(true);
  expect(spelled("VibeValley 工单", "VALLEY")).toBe(true);
  expect(spelled("VibeValley 工单", "工单")).toBe(true);
  expect(spelled("VibeValley 工单", "missing")).toBe(false);
  // Stock `nsh test` loads only `nsh/base`, so `richNative()` returns undefined and `spelled`
  // falls back synchronously to false without throwing.
  expect(spelled("工单", "gd")).toBe(false);
});

test("matches requires every whitespace-separated word across the candidate texts", () => {
  expect(matches("", ["工单"])).toBe(true);
  expect(matches("   ", ["工单"])).toBe(true);
  expect(matches("ai 帮工", [undefined, "", "AI 编码", "本地帮工"])).toBe(true);
  expect(matches("ai 不存在", ["AI 编码", "本地帮工"])).toBe(false);
});

test("compareText and or preserve deterministic sort order", () => {
  expect(compareText("a", "b")).toBe(-1);
  expect(compareText("b", "a")).toBe(1);
  expect(compareText("a", "a")).toBe(0);
  expect(or(0, 0, -1, 1)).toBe(-1);
  expect(or(0, 0)).toBe(0);
});
