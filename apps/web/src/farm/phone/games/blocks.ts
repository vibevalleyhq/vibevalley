// 方块: a game is a value, each move a function to the next. Pieces come from a seven-bag
// drawn with the game's own seeded generator, so a seed replays.

import { nextRandom } from "./random";

export const blocksWidth = 10;
export const blocksHeight = 18;

/** The seven pieces, in the order the well's marks count them; named by their letters. */
export const pieceKinds = ["I", "O", "T", "S", "Z", "J", "L"] as const;
export type PieceKind = (typeof pieceKinds)[number];

const shapes: Record<PieceKind, [size: number, cells: [number, number][]]> = {
  I: [
    4,
    [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  ],
  O: [
    2,
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
  ],
  T: [
    3,
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ],
  S: [
    3,
    [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
    ],
  ],
  Z: [
    3,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
  ],
  J: [
    3,
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ],
  L: [
    3,
    [
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ],
};

export interface Falling {
  readonly kind: PieceKind;
  /** 0..3. */
  readonly turn: number;
  readonly x: number;
  readonly y: number;
}

export interface Blocks {
  /** Row by row from the top: 0 is empty, else 1 + the index of the piece that left it (pieceKinds). */
  readonly well: readonly number[];
  readonly piece: Falling;
  readonly next: PieceKind;
  readonly bag: readonly PieceKind[];
  readonly seed: number;
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly over: boolean;
}

export function cellsOf(p: Falling): [number, number][] {
  const [size, cells] = shapes[p.kind];
  return cells.map(([cx, cy]) => {
    let [x, y] = [cx, cy];
    for (let i = 0; i < p.turn; i++) [x, y] = [size - 1 - y, x];
    return [p.x + x, p.y + y];
  });
}

function draw(bag: readonly PieceKind[], seed: number): [PieceKind, PieceKind[], number] {
  if (bag.length > 0) return [bag[0]!, bag.slice(1), seed];
  const fresh: PieceKind[] = [...pieceKinds];
  let s = seed;
  for (let i = fresh.length - 1; i > 0; i--) {
    const [r, n] = nextRandom(s);
    s = n;
    const j = Math.floor(r * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
  }
  return [fresh[0]!, fresh.slice(1), s];
}

const spawn = (kind: PieceKind): Falling => ({ kind, turn: 0, x: Math.floor((blocksWidth - shapes[kind][0]) / 2), y: 0 });

/** Above the top is fine. */
export const fits = (well: readonly number[], p: Falling) =>
  cellsOf(p).every(([x, y]) => x >= 0 && x < blocksWidth && y < blocksHeight && (y < 0 || well[y * blocksWidth + x] === 0));

export function newBlocks(seed: number): Blocks {
  const [first, bag1, s1] = draw([], seed);
  const [next, bag2, s2] = draw(bag1, s1);
  return { well: Array<number>(blocksWidth * blocksHeight).fill(0), piece: spawn(first), next, bag: bag2, seed: s2, score: 0, lines: 0, level: 1, over: false };
}

const linePoints = [0, 100, 300, 500, 800];

/** In milliseconds. */
export const fallMs = (level: number) => Math.max(90, 800 - (level - 1) * 70);

export function shift(g: Blocks, dx: number): Blocks {
  if (g.over) return g;
  const moved = { ...g.piece, x: g.piece.x + dx };
  return fits(g.well, moved) ? { ...g, piece: moved } : g;
}

/** Nudged off a wall or a stack (one, then two cells either way) when it would not fit. */
export function turn(g: Blocks): Blocks {
  if (g.over) return g;
  const turned = { ...g.piece, turn: (g.piece.turn + 1) % 4 };
  for (const dx of [0, -1, 1, -2, 2]) {
    const kicked = { ...turned, x: turned.x + dx };
    if (fits(g.well, kicked)) return { ...g, piece: kicked };
  }
  return g;
}

export function fall(g: Blocks): Blocks {
  if (g.over) return g;
  const lower = { ...g.piece, y: g.piece.y + 1 };
  return fits(g.well, lower) ? { ...g, piece: lower } : land(g);
}

/** Two points for each row dropped. */
export function slam(g: Blocks): Blocks {
  if (g.over) return g;
  let p = g.piece;
  let rows = 0;
  while (fits(g.well, { ...p, y: p.y + 1 })) {
    p = { ...p, y: p.y + 1 };
    rows++;
  }
  return land({ ...g, piece: p, score: g.score + rows * 2 });
}

export function landingOf(g: Blocks): Falling {
  let p = g.piece;
  while (fits(g.well, { ...p, y: p.y + 1 })) p = { ...p, y: p.y + 1 };
  return p;
}

function land(g: Blocks): Blocks {
  const well = [...g.well];
  const mark = pieceKinds.indexOf(g.piece.kind) + 1;
  let above = false;
  for (const [x, y] of cellsOf(g.piece)) {
    if (y < 0) above = true;
    else well[y * blocksWidth + x] = mark;
  }
  const kept: number[] = [];
  let cleared = 0;
  for (let y = 0; y < blocksHeight; y++) {
    const row = well.slice(y * blocksWidth, (y + 1) * blocksWidth);
    if (row.every((c) => c !== 0)) cleared++;
    else kept.push(...row);
  }
  const settled = [...Array<number>(cleared * blocksWidth).fill(0), ...kept];
  const lines = g.lines + cleared;
  const [after, bag, seed] = draw(g.bag, g.seed);
  const piece = spawn(g.next);
  return {
    well: settled,
    piece,
    next: after,
    bag,
    seed,
    score: g.score + linePoints[cleared]! * g.level,
    lines,
    level: 1 + Math.floor(lines / 10),
    over: above || !fits(settled, piece),
  };
}
