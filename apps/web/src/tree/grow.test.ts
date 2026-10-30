import { expect, test } from "vite-plus/test";

import { growthOf, growTree } from "./grow";
import { mockTree } from "./mock";
const now = Date.parse("2026-10-22T12:00:00+08:00");
const items = mockTree(now).items;

test("growth only rises with the rounds, and never passes one", () => {
  const steps = [0, 1, 5, 20, 80, 160, 1000].map(growthOf);
  for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]! - 1e-9);
  expect(steps.at(-1)).toBe(1);
});

test("a grown tree has more branches, a thicker trunk and stands taller than a young one", () => {
  const young = growTree(items, 0.2, 100);
  const old = growTree(items, 0.95, 100);
  expect(old.segments.length).toBeGreaterThan(young.segments.length * 3);
  expect(old.segments[0]!.width).toBeGreaterThan(young.segments[0]!.width);
  expect(old.top).toBeGreaterThan(young.top);
});

test("the same tree every time: growing on keeps the branches it had, only longer", () => {
  const a = growTree(items, 0.5, 100).segments[0]!;
  const b = growTree(items, 0.9, 100).segments[0]!;
  expect(Math.sign(a.x1)).toBe(Math.sign(b.x1));
  expect(growTree(items, 0.5, 100)).toEqual(growTree(items, 0.5, 100));
});

test("every leaf memory is a leaf; a sprout bears no fruit and keeps no seeds", () => {
  const leaves = items.filter((m) => m.kind === "leaf").length;
  expect(growTree(items, 0.9, 100).leaves).toHaveLength(leaves);
  const sprout = growTree(items, 0.08, 100);
  expect(sprout.leaves).toHaveLength(leaves);
  expect(sprout.fruits).toHaveLength(0);
  expect(sprout.seeds).toHaveLength(0);
  expect(growTree(items, 0.9, 100).fruits).toHaveLength(items.filter((m) => m.kind === "fruit").length);
});
