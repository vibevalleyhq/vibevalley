import { expect, test } from "vite-plus/test";

import { allOf, counts, kept } from "./memories";
import { mockTree } from "./mock";
import { constellation, starsOf, tiesOf } from "./sky";
const now = Date.parse("2026-10-22T12:00:00+08:00");

test("a memory for every project is kept under any project; a helper filter keeps only its own", () => {
  const tree = mockTree(now);
  const shared = tree.items.find((m) => m.project === null && m.kind === "leaf")!;
  expect(kept(shared, { agent: "", project: "官网" })).toBe(true);
  expect(kept(shared, { agent: shared.agent === "fox" ? "bear" : "fox", project: "" })).toBe(false);
  expect(tree.items.filter((m) => kept(m, allOf))).toHaveLength(tree.items.length);
});

test("the mock tree has the counts the concept shows, five of them fading", () => {
  expect(counts(mockTree(now).items)).toEqual({ leaf: 186, fruit: 42, seed: 7, fading: 5 });
});

test("seeds sit in the sky's middle, fruits around them, leaves outside", () => {
  const radius = (kind: string) =>
    starsOf(mockTree(now), now)
      .filter((s) => s.item.kind === kind)
      .map((s) => Math.hypot(s.x, s.z));
  expect(Math.max(...radius("seed"))).toBeLessThan(Math.min(...radius("fruit")));
  expect(Math.max(...radius("fruit"))).toBeLessThan(0.62);
  expect(Math.min(...radius("leaf"))).toBeGreaterThan(0.3);
});

test("a seed is tied to the fruits it grew from, and its constellation reaches down to their leaves", () => {
  const tree = mockTree(now);
  const seed = tree.items.find((m) => m.kind === "seed")!;
  const ties = tiesOf(tree.links, seed.id);
  expect(ties.from.length).toBeGreaterThanOrEqual(3);
  for (const f of ties.from) expect(tree.items.find((m) => m.id === f)!.kind).toBe("fruit");
  const stars = constellation(tree.links, seed.id);
  expect([...stars].some((id) => tree.items.find((m) => m.id === id)!.kind === "leaf")).toBe(true);
});

test("memories recalled together are tied both ways, the most often first", () => {
  const tree = mockTree(now);
  const pair = tree.links.find((l) => l.kind === "together")!;
  expect(tiesOf(tree.links, pair.a).together.map((t) => t.id)).toContain(pair.b);
  expect(tiesOf(tree.links, pair.b).together.map((t) => t.id)).toContain(pair.a);
  const times = tiesOf(tree.links, pair.a).together.map((t) => t.times);
  expect(times).toEqual([...times].toSorted((x, y) => y - x));
});

test("a constellation runs straight up and down: another seed from the same fruit stays out", () => {
  const tree = mockTree(now);
  const seeds = tree.items.filter((m) => m.kind === "seed");
  for (const seed of seeds) {
    const stars = constellation(tree.links, seed.id);
    for (const other of seeds) if (other !== seed) expect(stars.has(other.id)).toBe(false);
  }
});
