import { expect, test } from "vite-plus/test";
import { navMap, type Point } from "../src/nav";

// A 40x20 field with a wall at x 18..22 from the top down to y 14: the way round is under it.
const wall = (p: Point) => p.x >= 18 && p.x < 22 && p.y < 14;
const map = navMap({ w: 40, h: 20, cell: 2, clearance: 2, walkable: (p) => !wall(p) });

const crosses = (a: Point, b: Point) => {
  for (let s = 0; s <= 100; s++) if (wall({ x: a.x + ((b.x - a.x) * s) / 100, y: a.y + ((b.y - a.y) * s) / 100 })) return true;
  return false;
};

test("a route goes round what cannot be walked on, from the start to the end", () => {
  const from = { x: 4, y: 4 };
  const to = { x: 36, y: 4 };
  const route = map.route(from, to);
  expect(route[0]).toEqual(from);
  expect(route.at(-1)).toEqual(to);
  for (let i = 1; i < route.length; i++) expect(crosses(route[i - 1]!, route[i]!)).toBe(false);
  expect(Math.max(...route.map((p) => p.y))).toBeGreaterThanOrEqual(14);
});

test("an open line is walked straight, corners cut", () => {
  expect(map.route({ x: 4, y: 17 }, { x: 36, y: 17 })).toHaveLength(2);
});

test("a target inside a wall is reached from the nearest open cell", () => {
  const route = map.route({ x: 4, y: 4 }, { x: 20, y: 4 });
  expect(route.at(-1)).toEqual({ x: 20, y: 4 });
  expect(map.walkable({ x: 20, y: 4 })).toBe(false);
  expect(map.walkable({ x: 4, y: 4 })).toBe(true);
});
