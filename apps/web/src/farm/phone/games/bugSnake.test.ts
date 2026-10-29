// The same seeds must replay the same runs: the recorded ones are kept.
import { describe, expect, test } from "vite-plus/test";
import {
  type BugSnake,
  bugPoints,
  bugSnakeHeight,
  bugSnakeStepMs,
  bugSnakeWidth,
  bugTicks,
  crawlBugSnake,
  newBugSnake,
  type SnakeHeading,
  seedPoints,
  steerBugSnake,
} from "./bugSnake";

const w = bugSnakeWidth;
const at = (x: number, y: number) => y * w + x;
const lined = (o: Partial<BugSnake> = {}): BugSnake => ({ ...newBugSnake(1), food: at(0, 0), ...o });
const crawl = (g: BugSnake, n: number) => Array.from({ length: n }).reduce<BugSnake>((x) => crawlBugSnake(x), g);

/** The pilot: of the ways that do not end the run (up, right, down, left in that order, never back), the first nearest the bug or else the seed. */
function pilot(g: BugSnake): SnakeHeading {
  const target = g.bug ?? g.food;
  const head = g.body[0]!;
  const kept = g.grow > 0 ? g.body : g.body.slice(0, -1);
  const back: Record<SnakeHeading, SnakeHeading> = { up: "down", down: "up", left: "right", right: "left" };
  let best = g.heading;
  let bestDistance = 1 << 30;
  for (const [d, dx, dy] of [
    ["up", 0, -1],
    ["right", 1, 0],
    ["down", 0, 1],
    ["left", -1, 0],
  ] as const) {
    if (d === back[g.heading]) continue;
    const x = (head % w) + dx;
    const y = Math.floor(head / w) + dy;
    if (x < 0 || x >= w || y < 0 || y >= bugSnakeHeight || kept.includes(at(x, y))) continue;
    const distance = Math.abs(x - (target % w)) + Math.abs(y - Math.floor(target / w));
    if (distance < bestDistance) [best, bestDistance] = [d, distance];
  }
  return best;
}

function piloted(seed: number, ticks: number): [number, BugSnake] {
  let g = newBugSnake(seed);
  let t = 0;
  for (; t < ticks && g.over === undefined; t++) g = crawlBugSnake(steerBugSnake(g, pilot(g)));
  return [t, g];
}

describe("bug snake", () => {
  test("a new run: three segments heading right, a seed on a free cell", () => {
    const g = newBugSnake(7);
    expect([...g.body]).toEqual([at(5, 7), at(4, 7), at(3, 7)]);
    expect(g.food >= 0 && g.food < w * bugSnakeHeight && !g.body.includes(g.food)).toBe(true);
    expect(bugSnakeStepMs(g)).toBe(200);
  });

  test("it crawls a cell a tick, turns at the next tick, and never turns back on itself", () => {
    const g = crawlBugSnake(lined());
    expect([...g.body]).toEqual([at(6, 7), at(5, 7), at(4, 7)]);
    expect(steerBugSnake(g, "left")).toBe(g);
    expect(steerBugSnake(g, "right")).toBe(g);
    const up = crawlBugSnake(steerBugSnake(g, "up"));
    expect(up.heading).toBe("up");
    expect(up.body[0]).toBe(at(6, 6));
    const u = crawl(steerBugSnake(steerBugSnake(g, "up"), "left"), 2);
    expect([...u.body]).toEqual([at(5, 6), at(6, 6), at(6, 7)]);
    expect(steerBugSnake(steerBugSnake(steerBugSnake(g, "up"), "left"), "down").turns.length).toBe(2);
  });

  test("a seed grows it a segment and scores; another lands on a free cell", () => {
    const g = crawlBugSnake(lined({ food: at(6, 7) }));
    expect(g.eaten).toBe(1);
    expect(g.score).toBe(seedPoints);
    expect(g.body.includes(g.food)).toBe(false);
    const grown = crawlBugSnake(g);
    expect(grown.body.length).toBe(4);
    expect(crawlBugSnake(grown).body.length).toBe(4);
  });

  test("a bug lands with the fifth seed, is worth more the sooner, and flies off uneaten", () => {
    const g = crawlBugSnake(lined({ food: at(6, 7), eaten: 4 }));
    expect(g.eaten).toBe(5);
    expect(g.bug).not.toBeUndefined();
    expect(g.bugLeft).toBe(bugTicks);
    expect(!g.body.includes(g.bug!) && g.bug !== g.food).toBe(true);
    const fed = crawlBugSnake({ ...g, bug: at(7, 7), food: at(0, 0) });
    expect(fed.bugs).toBe(1);
    expect(fed.bug).toBeUndefined();
    expect(fed.score).toBe(seedPoints + bugPoints + bugTicks);
    expect(fed.grow).toBe(1 + 2 - 1);
    const away = { ...g, bug: at(15, 0), bugLeft: 5, food: at(0, 0), turns: [] };
    expect(crawl(away, 4).bug).toBe(at(15, 0));
    expect(crawl(away, 4).bugLeft).toBe(1);
    expect(crawl(away, 5).bug).toBeUndefined();
  });

  test("the wall and its own body end a run; its tail cell does not", () => {
    const wall = crawl(lined(), w);
    expect(wall.over).toBe("wall");
    expect(crawlBugSnake(wall)).toBe(wall);
    expect(steerBugSnake(wall, "up")).toBe(wall);
    const ring = lined({ body: [at(5, 6), at(5, 7), at(6, 7), at(6, 6)], heading: "up", turns: ["right"] });
    expect(crawlBugSnake(ring).over).toBeUndefined();
    expect(crawlBugSnake({ ...ring, grow: 1 }).over).toBe("self");
    const long = lined({ body: [at(5, 6), at(5, 7), at(6, 7), at(6, 6), at(7, 6)], heading: "up", turns: ["right"] });
    expect(crawlBugSnake(long).over).toBe("self");
  });

  test("it quickens as it grows", () => {
    expect(bugSnakeStepMs(lined({ body: Array.from({ length: 20 }, (_, i) => i) }))).toBeLessThan(200);
    expect(bugSnakeStepMs(lined({ body: Array.from({ length: 100 }, (_, i) => i) }))).toBe(80);
  });

  test("a seed replays the recorded run", () => {
    const summary = (seed: number) => {
      const [t, g] = piloted(seed, 3000);
      return [t, g.over, g.score, g.eaten, g.bugs, g.body.length, g.food, g.bug, g.seed];
    };
    expect(summary(1)).toEqual([266, "self", 357, 20, 3, 29, 111, 144, -1455494930]);
    expect(summary(42)).toEqual([255, "wall", 312, 18, 3, 27, 10, undefined, 1639742264]);
    expect(summary(2024)).toEqual([191, "self", 248, 15, 2, 22, 32, 0, 440014103]);
    expect([1, 42, 2024].map((s) => newBugSnake(s).food)).toEqual([141, 135, 182]);
  });
});
