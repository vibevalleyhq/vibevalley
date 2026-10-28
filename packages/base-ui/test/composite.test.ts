import { expect, test } from "vite-plus/test";
import { moveIndex, typeahead } from "../src/internal/composite.ts";

test("arrows follow the orientation, Home and End go to the ends, and only a loop wraps", () => {
  const o = { orientation: "horizontal" as const, loop: false };
  expect([moveIndex("ArrowRight", 0, 3, o), moveIndex("ArrowLeft", 0, 3, o), moveIndex("ArrowDown", 0, 3, o)]).toEqual([1, 0, undefined]);
  expect([moveIndex("Home", 2, 3, o), moveIndex("End", 0, 3, o)]).toEqual([0, 2]);
  expect(moveIndex("ArrowRight", 2, 3, { ...o, loop: true })).toBe(0);
  expect(moveIndex("ArrowUp", 0, 3, { orientation: "vertical", loop: true })).toBe(2);
});

test("disabled items are passed over", () => {
  const enabled = (i: number) => i !== 1;
  expect(moveIndex("ArrowDown", 0, 3, { orientation: "vertical", loop: false, enabled })).toBe(2);
  expect(moveIndex("Home", 2, 3, { orientation: "both", loop: false, enabled: (i) => i > 0 })).toBe(1);
});

test("typing finds the next item by its start, and a repeated letter cycles", () => {
  const labels = ["Apple", "Banana", "Blueberry", "Cherry"];
  expect(typeahead(labels, 0, "b")).toBe(1);
  expect(typeahead(labels, 1, "b")).toBe(2);
  expect(typeahead(labels, 1, "bl")).toBe(2);
  expect(typeahead(labels, 2, "bb")).toBe(1);
  expect(typeahead(labels, 0, "z")).toBeUndefined();
});
