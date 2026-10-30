// 小恐龙: a run is a value and `run` moves it on by some milliseconds. Sizes are the game's own
// pixels on a 104×40 strip, y down; a seed replays.

import { nextRandom } from "./random";

export const dinoWidth = 104;
export const dinoHeight = 40;
export const dinoGround = 35;
const dinoX = 8;

const dinoRunSize = { w: 12, h: 14 } as const;
const dinoDuckSize = { w: 16, h: 8 } as const;

export type ObstacleKind = "cactus" | "cacti" | "bird";

export interface Obstacle {
  readonly kind: ObstacleKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Dino {
  /** Height above the ground, pixels. */
  readonly lift: number;
  /** Pixels per millisecond. */
  readonly rise: number;
  readonly ducking: boolean;
  readonly obstacles: readonly Obstacle[];
  /** Pixels per millisecond. */
  readonly speed: number;
  /** The score is a tenth of it. */
  readonly distance: number;
  readonly gap: number;
  readonly seed: number;
  readonly over: boolean;
  readonly time: number;
}

// Long enough to clear the widest cacti at the starting speed with room to spare (dino.test.ts checks it).
const gravity = 0.0008;
const jumpRise = 0.21;
const dive = 0.004;
const startSpeed = 0.08;
const topSpeed = 0.17;
const speedUp = 0.000008;
const birdsFrom = 2000;

export const newDino = (seed: number): Dino => ({
  lift: 0,
  rise: 0,
  ducking: false,
  obstacles: [],
  speed: startSpeed,
  distance: 0,
  gap: 40,
  seed,
  over: false,
  time: 0,
});

export const dinoScore = (d: Dino) => Math.floor(d.distance / 10);

export const jump = (d: Dino): Dino => (d.over || d.lift > 0 ? d : { ...d, rise: jumpRise, ducking: false });

export const duck = (d: Dino, down: boolean): Dino => (d.over ? d : { ...d, ducking: down });

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function dinoBox(d: Dino): Box {
  const size = d.ducking && d.lift === 0 ? dinoDuckSize : dinoRunSize;
  return { x: dinoX, y: dinoGround - d.lift - size.h, w: size.w, h: size.h };
}

function spawn(d: Dino, seed: number): [Obstacle, number, number] {
  const [r1, s1] = nextRandom(seed);
  const [r2, s2] = nextRandom(s1);
  const birds = d.distance > birdsFrom;
  const kind: ObstacleKind = birds && r1 < 0.25 ? "bird" : r1 < 0.65 ? "cactus" : "cacti";
  // Low birds are jumped, high ones ducked under.
  const [w, h, y] =
    kind === "bird" ? [12, 8, r2 < 0.5 ? dinoGround - 12 : dinoGround - 18] : kind === "cactus" ? [6, 12, dinoGround - 12] : [12, 10, dinoGround - 10];
  // Faster runs leave more room, so a jump can always clear one obstacle before the next.
  const gap = 50 + r2 * 60 + d.speed * 200;
  return [{ kind, x: dinoWidth, y, w, h }, gap, s2];
}

/** With grace (two pixels at the sides, where the pictures' corners are empty; one above and below): a graze is not a hit. */
const hits = (a: Box, b: Obstacle) => a.x + 2 < b.x + b.w - 2 && b.x + 2 < a.x + a.w - 2 && a.y + 1 < b.y + b.h - 1 && b.y + 1 < a.y + a.h - 1;

export function run(d: Dino, ms: number): Dino {
  if (d.over) return d;
  const dt = Math.min(ms, 50);
  const pull = gravity + (d.ducking && d.lift > 0 ? dive : 0);
  let rise = d.rise - pull * dt;
  let lift = d.lift + rise * dt;
  if (lift <= 0) [lift, rise] = [0, 0];
  const moved = d.speed * dt;
  let obstacles = d.obstacles.filter((o) => o.x - moved + o.w > 0).map((o) => ({ ...o, x: o.x - moved }));
  let gap = d.gap - moved;
  let seed = d.seed;
  if (gap <= 0) {
    const [o, next, s] = spawn(d, seed);
    obstacles = [...obstacles, o];
    gap = next;
    seed = s;
  }
  const next: Dino = {
    ...d,
    lift,
    rise,
    obstacles,
    gap,
    seed,
    distance: d.distance + moved,
    speed: Math.min(topSpeed, d.speed + moved * speedUp),
    time: d.time + dt,
  };
  const me = dinoBox(next);
  return obstacles.some((o) => hits(me, o)) ? { ...next, over: true } : next;
}
