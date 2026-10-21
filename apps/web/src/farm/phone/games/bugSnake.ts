// 贪吃虫: a snake that eats seeds and, every fifth, a bug that flies off after a while.
// Cells are y * width + x; seeds and bugs land on free cells drawn with the run's own seeded generator, so a seed replays.

import { nextRandom } from "./random";

export const bugSnakeWidth = 16;
export const bugSnakeHeight = 14;

export type SnakeHeading = "up" | "down" | "left" | "right";
export type BugSnakeEnd = "wall" | "self" | "full";

export interface BugSnake {
  readonly body: readonly number[];
  readonly heading: SnakeHeading;
  /** At most two, so a quick double turn is not lost between ticks. */
  readonly turns: readonly SnakeHeading[];
  /** The tail stays put a tick for each. */
  readonly grow: number;
  readonly food: number;
  /** With the ticks before it flies off. */
  readonly bug: number | null;
  readonly bugLeft: number;
  readonly eaten: number;
  readonly bugs: number;
  readonly score: number;
  readonly seed: number;
  readonly over: BugSnakeEnd | null;
}

export const seedPoints = 10;
/** Plus the ticks it had left. */
export const bugPoints = 20;
export const bugTicks = 40;
const bugEvery = 5;
const maxTurns = 2;

const step: Record<SnakeHeading, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const opposite: Record<SnakeHeading, SnakeHeading> = { up: "down", down: "up", left: "right", right: "left" };

/** -1 when there is none. */
function place(taken: readonly number[], seed: number): [number, number] {
  const free: number[] = [];
  for (let c = 0; c < bugSnakeWidth * bugSnakeHeight; c++) if (!taken.includes(c)) free.push(c);
  if (free.length === 0) return [-1, seed];
  const [r, s] = nextRandom(seed);
  return [free[Math.floor(r * free.length)]!, s];
}

export function newBugSnake(seed: number): BugSnake {
  const row = Math.floor(bugSnakeHeight / 2) * bugSnakeWidth;
  const body = [row + 5, row + 4, row + 3];
  const [food, s] = place(body, seed);
  return { body, heading: "right", turns: [], grow: 0, food, bug: null, bugLeft: 0, eaten: 0, bugs: 0, score: 0, seed: s, over: null };
}

export const bugSnakeStepMs = (g: BugSnake) => Math.max(80, 200 - (g.body.length - 3) * 4);

/** Turning back onto itself, or the way it already goes, is ignored. */
export function steerBugSnake(g: BugSnake, to: SnakeHeading): BugSnake {
  if (g.over !== null || g.turns.length >= maxTurns) return g;
  const last = g.turns.at(-1) ?? g.heading;
  return to === last || to === opposite[last] ? g : { ...g, turns: [...g.turns, to] };
}

export function crawlBugSnake(g: BugSnake): BugSnake {
  if (g.over !== null) return g;
  const heading = g.turns[0] ?? g.heading;
  const turns = g.turns.slice(1);
  const head = g.body[0]!;
  const [dx, dy] = step[heading];
  const x = (head % bugSnakeWidth) + dx;
  const y = Math.floor(head / bugSnakeWidth) + dy;
  if (x < 0 || x >= bugSnakeWidth || y < 0 || y >= bugSnakeHeight) return { ...g, heading, turns, over: "wall" };
  const to = y * bugSnakeWidth + x;
  const kept = g.grow > 0 ? g.body : g.body.slice(0, -1);
  if (kept.includes(to)) return { ...g, heading, turns, over: "self" };
  const body = [to, ...kept];
  let { grow, food, bug, bugLeft, eaten, bugs, score, seed } = g;
  if (grow > 0) grow--;
  if (bug !== null && to === bug) {
    score += bugPoints + bugLeft;
    grow += 2;
    bugs++;
    [bug, bugLeft] = [null, 0];
  } else if (bug !== null && --bugLeft <= 0) {
    [bug, bugLeft] = [null, 0];
  }
  let over: BugSnakeEnd | null = null;
  if (to === food) {
    score += seedPoints;
    grow++;
    eaten++;
    [food, seed] = place(bug === null ? body : [...body, bug], seed);
    if (food === -1) over = "full";
    else if (eaten % bugEvery === 0 && bug === null) {
      const [landed, s] = place([...body, food], seed);
      seed = s;
      if (landed !== -1) [bug, bugLeft] = [landed, bugTicks];
    }
  }
  return { body, heading, turns, grow, food, bug, bugLeft, eaten, bugs, score, seed, over };
}
