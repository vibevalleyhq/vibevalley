import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { waterfallWidths } from "./runs";

const sumOf = (xs: readonly number[]) => xs.reduce((total, x) => total + x, 0);

function expectClose(actual: number | undefined, expected: number, tolerance = 1e-6) {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(tolerance);
}

test("waterfallWidths returns empty on non-positive room or empty durations", () => {
  expect(waterfallWidths([], 400)).toEqual([]);
  expect(waterfallWidths([100, 200], 0)).toEqual([]);
  expect(waterfallWidths([100, 200], -10)).toEqual([]);
});

test("waterfallWidths splits room evenly when all durations are zero or non-positive", () => {
  expect(waterfallWidths([0, 0, 0], 300)).toEqual([100, 100, 100]);
  expect(waterfallWidths([-5, 0], 200)).toEqual([100, 100]);
});

test("waterfallWidths preserves linear scaling for equal and mild duration ratios", () => {
  expect(waterfallWidths([5_000, 5_000], 400)).toEqual([200, 200]);

  const mild = waterfallWidths([10_000, 40_000, 30_000], 800);
  expectClose(mild[0], 100);
  expectClose(mild[1], 400);
  expectClose(mild[2], 300);
  expectClose(sumOf(mild), 800);
});

test("waterfallWidths dampens 11s vs 7h36m extreme ratio while preserving order and room sum", () => {
  const elevenSeconds = 11_000;
  const sevenHours = (7 * 60 + 36) * 60_000;
  const widths = waterfallWidths([elevenSeconds, sevenHours], 560);
  expect(widths.length).toBe(2);
  expect(widths[0]).toBeGreaterThanOrEqual(44);
  expect(widths[1]).toBeGreaterThan(widths[0]);
  expectClose(sumOf(widths), 560);

  const withZero = waterfallWidths([0, elevenSeconds, sevenHours], 560);
  expect(withZero[0]).toBe(0);
  expect(withZero[1]).toBeGreaterThanOrEqual(44);
  expect(withZero[2]).toBeGreaterThan(withZero[1]);
  expectClose(sumOf(withZero), 560);

  const tight = waterfallWidths([1_000, 1_000_000], 60);
  expect(tight[0]).toBeGreaterThanOrEqual(30);
  expectClose(sumOf(tight), 60);
});
