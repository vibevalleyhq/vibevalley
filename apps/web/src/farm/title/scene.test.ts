import { expect, test } from "vite-plus/test";

import { hourNow, motesOf, sceneAt } from "./scene";

test("the hour picks the scene, and ?tod overrides the clock", () => {
  expect([4.9, 5, 8.9, 9, 15.9, 16, 19.4, 19.5, 23].map(sceneAt)).toEqual([
    "night",
    "morning",
    "morning",
    "day",
    "day",
    "evening",
    "evening",
    "night",
    "night",
  ]);
  expect(hourNow("?tod=0.25", new Date(2026, 0, 1, 20, 30))).toBe(6);
  expect(hourNow("", new Date(2026, 0, 1, 20, 30))).toBe(20.5);
  expect(hourNow("?tod=2", new Date(2026, 0, 1, 20, 30))).toBe(20.5);
});

test("fireflies only at dusk and night, the same each time, in the fields", () => {
  expect(motesOf("day")).toEqual([]);
  expect(motesOf("night")).toHaveLength(26);
  expect(motesOf("evening")).toEqual(motesOf("evening"));
  for (const m of motesOf("night")) {
    expect(m.x).toBeGreaterThanOrEqual(30);
    expect(m.y).toBeGreaterThanOrEqual(48);
    expect([3, 4]).toContain(m.size);
  }
});
