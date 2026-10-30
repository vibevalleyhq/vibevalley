import { expect, test } from "vite-plus/test";

import { filledNear, fills } from "../src/framing";

const picture = { w: 384, h: 256 };
const cut = { across: 0.05, down: 0.08 };
const min = { w: 768, h: 512 };
const max = { w: 2000, h: 1300 };

test("a view between two whole scales has bars; one at a scale, or a little under it, is filled", () => {
  expect(fills({ w: 1220, h: 813 }, picture, cut)).toBe(false);
  expect(fills({ w: 1152, h: 768 }, picture, cut)).toBe(true);
  expect(fills({ w: 1100, h: 733 }, picture, cut)).toBe(true);
});

test("a view with bars goes to the nearest filled size of its shape, and a filled one stays", () => {
  expect(filledNear({ w: 1220, h: 813 }, picture, cut, min, max)).toEqual({ w: 1152, h: 768 });
  expect(filledNear({ w: 1350, h: 900 }, picture, cut, min, max)).toEqual({ w: 1383, h: 922 });
  expect(filledNear({ w: 1100, h: 733 }, picture, cut, min, max)).toEqual({ w: 1100, h: 733 });
});

test("the nearest filled size is never outside the bounds", () => {
  const small = { w: 1300, h: 867 };
  for (let w = 768; w <= 2000; w += 7) {
    const to = filledNear({ w, h: Math.round((w * 2) / 3) }, picture, cut, min, small);
    expect(to.w).toBeLessThanOrEqual(Math.max(w, small.w));
    if (to.w !== w) expect(fills(to, picture, cut)).toBe(true);
  }
});
